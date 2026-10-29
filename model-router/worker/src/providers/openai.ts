/** Stateless, non-streaming OpenAI Responses API. */
import type { GenerateRequest } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import type { ProviderContext, ProviderResult } from '../types.ts';
import { apiKey, deadlineSignal, httpError, parseSchema, providerStatus, readJson, refusedBeforeGeneration, timedOut } from './common.ts';
import { openaiUsage, record, unknownUsage, zeroUsage } from './usage.ts';

function responseError(value: unknown, status: number, headers?: Headers): ReturnType<typeof providerStatus> {
  const error = record(value);
  const code = error?.['code'] ?? error?.['type'];
  if (typeof code === 'string' && ['credit_balance_exhausted', 'insufficient_quota', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded',
    'organization_usage_limit_exceeded', 'usage_limit_exceeded'].includes(code))
    return providerStatus(8, 'openai_spend_limit', 'MODEL_SPEND_LIMIT');
  if (code === 'content_filter' || code === 'safety_violation')
    return providerStatus(9, 'openai_refused', 'MODEL_REFUSED');
  if (code === 'rate_limit_exceeded') return httpError('openai', 429, headers);
  return httpError('openai', status, headers);
}

function outputText(value: Record<string, unknown>): { text: string; refused: boolean; valid: boolean } {
  let text = '';
  let refused = false;
  if (!Array.isArray(value['output'])) return { text, refused, valid: false };
  for (const item of value['output']) {
    const message = record(item);
    if (message?.['type'] === 'reasoning') continue;
    if (message?.['type'] !== 'message' || message['role'] !== 'assistant' || !Array.isArray(message['content']))
      return { text, refused, valid: false };
    for (const content of message['content']) {
      const part = record(content);
      if (part?.['type'] === 'refusal') refused = true;
      else if (part?.['type'] === 'output_text' && typeof part['text'] === 'string') text += part['text'];
      else return { text, refused, valid: false };
    }
  }
  return { text, refused, valid: true };
}

export async function generateOpenAI(request: GenerateRequest, context: ProviderContext): Promise<ProviderResult> {
  const base: ProviderResult = { output: '', reportedModel: '', usage: unknownUsage(), observations: { searched: false, openedUrls: [] } };
  const fail = (code: number, message: string): ProviderResult => ({ ...base, error: providerStatus(code, message) });
  if ((request.effort && !context.route.efforts.includes(request.effort))
    || !Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 0 || request.maxOutputTokens > 64_000)
    return fail(3, 'openai_unsupported_parameters');
  const key = apiKey(context, 'OPENAI');
  if (key === null) return fail(9, 'openai_not_configured');
  let schema: Record<string, unknown> | null;
  try { schema = parseSchema(request.outputSchemaJson); } catch { return fail(3, 'output_schema_invalid'); }
  if (context.signal.aborted) return timedOut(context.signal) ? fail(4, 'openai_deadline') : fail(1, 'openai_cancelled');
  if (context.deadlineMs <= Date.now()) return fail(4, 'openai_deadline');
  const deadline = deadlineSignal(context);
  try {
    const response = await context.fetcher('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      signal: deadline.signal, redirect: 'manual',
      body: JSON.stringify({
        model: context.route.upstreamModel, input: request.input, stream: false, store: false, service_tier: 'default',
        ...(request.instructions.length ? { instructions: request.instructions.map(block => block.text).join('\n\n') } : {}),
        ...(request.effort ? { reasoning: { effort: request.effort } } : {}),
        ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
        ...(schema === null ? {} : { text: { format: { type: 'json_schema', name: 'router_output', strict: true, schema } } }),
      }),
    });
    if (!response.ok) {
      const value = record(await readJson(response, 65_536).catch(() => null));
      base.reportedModel = typeof value?.['model'] === 'string' ? value['model'] : '';
      base.usage = value?.['usage'] ? openaiUsage(value['usage'], base.reportedModel, value['service_tier'])
        : refusedBeforeGeneration(response.status) ? zeroUsage() : unknownUsage();
      return { ...base, error: responseError(value?.['error'], response.status, response.headers) };
    }
    const value = record(await readJson(response));
    if (value === null) return fail(13, 'openai_invalid_response');
    base.reportedModel = typeof value['model'] === 'string' ? value['model'] : '';
    base.usage = openaiUsage(value['usage'], base.reportedModel, value['service_tier']);
    const output = outputText(value);
    const incomplete = record(value['incomplete_details'])?.['reason'];
    if (output.refused || incomplete === 'content_filter')
      return { ...base, error: providerStatus(9, 'openai_refused', 'MODEL_REFUSED') };
    if (value['error']) return { ...base, error: responseError(value['error'], 500) };
    if (value['status'] === 'incomplete' && incomplete === 'max_output_tokens')
      return { ...base, error: providerStatus(13, 'openai_output_limit', 'MODEL_OUTPUT_LIMIT') };
    if (value['status'] !== 'completed') return fail(13, 'openai_incomplete');
    if (!output.valid || !output.text.trim()) return fail(13, 'openai_invalid_response');
    return { ...base, output: output.text, contributingModels: base.reportedModel ? [base.reportedModel] : [] };
  } catch (error) {
    if (context.signal.aborted) return timedOut(context.signal) ? fail(4, 'openai_timeout') : fail(1, 'openai_cancelled');
    const invalid = error instanceof SyntaxError || (error instanceof Error && ['provider_empty_response', 'provider_response_too_large'].includes(error.message));
    return fail(deadline.signal.aborted ? 4 : invalid ? 13 : 14, deadline.signal.aborted ? 'openai_timeout' : invalid ? 'openai_invalid_response' : 'openai_connection');
  } finally {
    deadline.clear();
  }
}
