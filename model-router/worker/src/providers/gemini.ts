/** Gemini generateContent with an one actual native model per invocation. */
import type { GenerateRequest } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import type { ProviderContext, ProviderResult } from '../types.ts';
import { apiKey, deadlineSignal, httpError, parseSchema, providerStatus, readJson, refusedBeforeGeneration, timedOut } from './common.ts';
import { geminiUsage, record, unknownUsage, zeroUsage } from './usage.ts';

const MODEL_TIMEOUT_MS = 60_000;
const MIN_ATTEMPT_MS = 1000;

function firstCandidate(value: Record<string, unknown>): { text: string; finish: string; blocked: boolean } {
  const candidate = record(Array.isArray(value['candidates']) ? value['candidates'][0] : null);
  const parts = record(candidate?.['content'])?.['parts'];
  const text = Array.isArray(parts) ? parts.map(record).filter(part => part !== null && part['thought'] !== true).map(part => typeof part?.['text'] === 'string' ? part['text'] : '').join('') : '';
  const finish = typeof candidate?.['finishReason'] === 'string' ? candidate['finishReason'] : '';
  const feedback = record(value['promptFeedback']);
  const blocked = typeof feedback?.['blockReason'] === 'string' && feedback['blockReason'] !== 'BLOCK_REASON_UNSPECIFIED';
  return { text, finish, blocked };
}

/** Gemini also answers a bad key (API_KEY_INVALID) or an account it will not serve (FAILED_PRECONDITION) with 400. */
async function configuration400(response: Response): Promise<number | null> {
  const error = record(record(await readJson(response, 65_536).catch(() => null))?.['error']);
  const details = Array.isArray(error?.['details']) ? error['details'].map(record) : [];
  if (details.some(detail => typeof detail?.['reason'] === 'string' && detail['reason'].startsWith('API_KEY_'))) return 7;
  return error?.['status'] === 'FAILED_PRECONDITION' ? 9 : null;
}

export async function generateGemini(request: GenerateRequest, context: ProviderContext): Promise<ProviderResult> {
  const base: ProviderResult = { output: '', reportedModel: '', usage: unknownUsage(), observations: { searched: false, openedUrls: [] } };
  const fail = (code: number, message: string): ProviderResult => ({ ...base, error: providerStatus(code, message) });
  if ((request.effort && !context.route.efforts.includes(request.effort))
    || !Number.isInteger(request.maxOutputTokens) || request.maxOutputTokens < 0 || request.maxOutputTokens > 65_536) return fail(3, 'gemini_unsupported_parameters');
  const key = apiKey(context, 'GEMINI');
  if (key === null) return fail(9, 'gemini_not_configured');
  let schema: Record<string, unknown> | null;
  try { schema = parseSchema(request.outputSchemaJson); } catch { return fail(3, 'output_schema_invalid'); }
  if (context.signal.aborted) return timedOut(context.signal) ? fail(4, 'gemini_deadline') : fail(1, 'gemini_cancelled');
  if (context.deadlineMs - Date.now() < MIN_ATTEMPT_MS) return fail(4, 'gemini_deadline');
  const deadline = deadlineSignal(context, MODEL_TIMEOUT_MS);
  const body = JSON.stringify({
    ...(request.instructions.length === 0 ? {} : { systemInstruction: { parts: request.instructions.map(block => ({ text: block.text })) } }),
    contents: [{ role: 'user', parts: [{ text: request.input }] }],
    generationConfig: {
      ...(schema === null ? {} : { responseMimeType: 'application/json', responseJsonSchema: schema }),
      ...(request.effort === '' ? {} : { thinkingConfig: { thinkingLevel: request.effort.toUpperCase() } }),
      ...(request.maxOutputTokens === 0 ? {} : { maxOutputTokens: request.maxOutputTokens }),
    },
  });
  try {
    const response = await context.fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(context.route.upstreamModel)}:generateContent`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body, signal: deadline.signal, redirect: 'manual',
    });
    if (!response.ok) {
      const configuration = response.status === 400 ? await configuration400(response) : null;
      if (response.status !== 400) await response.body?.cancel();
      if (refusedBeforeGeneration(response.status)) base.usage = zeroUsage();
      if (configuration !== null) return { ...base, error: providerStatus(configuration, 'gemini_http_400') };
      return { ...base, error: httpError('gemini', response.status, response.headers) };
    }
    const value = record(await readJson(response));
    if (value === null) return fail(13, 'gemini_invalid_response');
    base.reportedModel = typeof value['modelVersion'] === 'string' ? value['modelVersion'] : '';
    base.usage = geminiUsage(value['usageMetadata'], base.reportedModel);
    const candidate = firstCandidate(value);
    if (candidate.blocked || ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION'].includes(candidate.finish))
      return { ...base, error: providerStatus(9, 'gemini_refused', 'MODEL_REFUSED') };
    if (candidate.finish === 'MAX_TOKENS')
      return { ...base, error: providerStatus(8, 'gemini_output_limit', 'MODEL_OUTPUT_LIMIT') };
    if (candidate.finish !== 'STOP' || candidate.text.trim() === '') return fail(13, 'gemini_incomplete');
    return { ...base, output: candidate.text, contributingModels: base.reportedModel ? [base.reportedModel] : [] };
  } catch (error) {
    if (context.signal.aborted) return timedOut(context.signal) ? fail(4, 'gemini_timeout') : fail(1, 'gemini_cancelled');
    const invalid = error instanceof SyntaxError || (error instanceof Error && ['provider_empty_response', 'provider_response_too_large'].includes(error.message));
    return fail(deadline.signal.aborted ? 4 : invalid ? 13 : 14, deadline.signal.aborted ? 'gemini_timeout' : invalid ? 'gemini_invalid_response' : 'gemini_connection');
  } finally {
    deadline.clear();
  }
}
