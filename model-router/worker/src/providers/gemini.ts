/** Gemini generateContent with an explicitly configured, bounded model fallback chain. */
import type { GenerationConfig } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import type { ProviderContext, ProviderResult } from '../types.ts';
import { apiKey, deadlineSignal, httpError, parseSchema, providerStatus, readJson } from './common.ts';
import { addUsage, geminiUsage, record, unknownUsage, type TokenUsage } from './usage.ts';

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

export async function generateGemini(config: GenerationConfig, input: string, context: ProviderContext): Promise<ProviderResult> {
  const parameters = {
    effort: config.parameters?.effort ?? '',
    allowFallback: config.parameters?.allowFallback ?? false,
    ...(config.parameters?.temperature === undefined ? {} : { temperature: config.parameters.temperature }),
    ...(config.parameters?.maxOutputTokens === undefined ? {} : { maxOutputTokens: config.parameters.maxOutputTokens }),
  };
  let base: ProviderResult = { output: '', reportedModel: '', usage: unknownUsage(), observations: { searched: false, openedUrls: [] }, parameters, upstreamStarted: false, attemptCount: 0, finishReason: '' };
  const fail = (code: number, message: string): ProviderResult => ({ ...base, error: providerStatus(code, message) });
  if (config.webResearch || (parameters.effort !== '' && !context.route.efforts.includes(parameters.effort))
    || (parameters.temperature !== undefined && (!context.route.temperature || !Number.isFinite(parameters.temperature) || parameters.temperature < 0 || parameters.temperature > 2))
    || (parameters.maxOutputTokens !== undefined && (!context.route.maxOutputTokens || !Number.isInteger(parameters.maxOutputTokens) || parameters.maxOutputTokens < 1 || parameters.maxOutputTokens > 65_536))) return fail(3, 'gemini_unsupported_parameters');
  const key = apiKey(context, 'GEMINI');
  if (key === null) return fail(9, 'gemini_not_configured');
  let schema: Record<string, unknown> | null;
  try { schema = parseSchema(config.outputSchemaJson); } catch { return fail(3, 'output_schema_invalid'); }
  const body = JSON.stringify({
    ...(config.instructions.length === 0 ? {} : { systemInstruction: { parts: config.instructions.map(block => ({ text: block.text })) } }),
    contents: [...(context.history ?? []).map(turn => ({ role: turn.role === 'assistant' ? 'model' : 'user', parts: [{ text: turn.content }] })), { role: 'user', parts: [{ text: input }] }],
    generationConfig: {
      ...(schema === null ? {} : { responseMimeType: 'application/json', responseJsonSchema: schema }),
      ...(parameters.effort === '' ? {} : { thinkingConfig: { thinkingLevel: parameters.effort.toUpperCase() } }),
      ...(parameters.temperature === undefined ? {} : { temperature: parameters.temperature }),
      ...(parameters.maxOutputTokens === undefined ? {} : { maxOutputTokens: parameters.maxOutputTokens }),
    },
  });
  const models = [...new Set([context.route.upstreamModel, ...(parameters.allowFallback ? context.route.fallbackModels ?? [] : [])])];
  let usage: TokenUsage | null = null;
  for (const model of models) {
    if (context.signal.aborted) return fail(1, 'gemini_cancelled');
    if (context.deadlineMs - Date.now() < MIN_ATTEMPT_MS) return fail(4, 'gemini_deadline');
    const deadline = deadlineSignal(context, MODEL_TIMEOUT_MS);
    let response: Response;
    let value: Record<string, unknown> | null;
    try {
      base.attemptCount = (base.attemptCount ?? 0) + 1;
      response = await context.fetcher(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body, signal: deadline.signal, redirect: 'manual',
      });
      if (!response.ok) {
        await response.body?.cancel();
        usage = { ...(usage ?? unknownUsage()), available: false };
        base = { ...base, error: httpError('gemini', response.status), usage };
        if (response.status === 404 || response.status === 429 || response.status >= 500) continue;
        return base;
      }
      base.upstreamStarted = true;
      value = record(await readJson(response));
    } catch (error) {
      usage = { ...(usage ?? unknownUsage()), available: false };
      const invalid = error instanceof SyntaxError || (error instanceof Error && ['provider_empty_response', 'provider_response_too_large'].includes(error.message));
      base = { ...base, error: providerStatus(deadline.signal.aborted ? 4 : invalid ? 13 : 14, deadline.signal.aborted ? 'gemini_timeout' : invalid ? 'gemini_invalid_response' : 'gemini_connection'), usage };
      if (context.signal.aborted) return fail(1, 'gemini_cancelled');
      continue;
    } finally {
      deadline.clear();
    }
    if (value === null) {
      usage = { ...(usage ?? unknownUsage()), available: false };
      base = { ...base, usage };
      base = fail(13, 'gemini_invalid_response');
      continue;
    }
    const currentUsage = geminiUsage(value['usageMetadata']);
    usage = usage === null ? currentUsage : addUsage(usage, currentUsage);
    base = { ...base, reportedModel: typeof value['modelVersion'] === 'string' ? value['modelVersion'] : '', usage };
    const candidate = firstCandidate(value);
    if (candidate.blocked || ['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION'].includes(candidate.finish)) {
      base = { ...base, finishReason: 'refused', error: providerStatus(9, 'gemini_refused', 'MODEL_REFUSED') };
      continue;
    }
    if (candidate.finish === 'MAX_TOKENS') {
      base = { ...base, finishReason: 'output_limit', error: providerStatus(8, 'gemini_output_limit', 'MODEL_OUTPUT_LIMIT') };
      continue;
    }
    if (candidate.finish !== 'STOP' || candidate.text.trim() === '') {
      base = fail(13, 'gemini_incomplete');
      continue;
    }
    const success = { ...base };
    delete success.error;
    return { ...success, output: candidate.text, finishReason: 'complete', contributingModels: base.reportedModel ? [base.reportedModel] : [] };
  }
  return base.error === undefined ? fail(13, 'gemini_no_result') : base;
}
