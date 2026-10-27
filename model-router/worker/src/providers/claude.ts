/** Claude Messages API. Streaming stays internal; callers receive one final result. */
import Anthropic, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type { BetaMessage, MessageCreateParamsBase } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { GenerateRequest } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import type { ProviderContext, ProviderResult } from '../types.ts';
import { apiKey, deadlineSignal, httpError, parseSchema, providerStatus, refusedBeforeGeneration, timedOut } from './common.ts';
import { claudeUsage, record, unknownUsage, zeroUsage } from './usage.ts';

const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const HEADER_TIMEOUT_MS = 120_000;
const STALL_MS = 180_000;
const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

/** Cap total bytes and reset the stream watchdog for every chunk, including pings. */
function watchedFetch(fetcher: typeof fetch, onBytes: () => void): typeof fetch {
  return async (input, init) => {
    const response = await fetcher(input, init);
    onBytes();
    if (response.body === null) return response;
    let bytes = 0;
    const stream = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        onBytes();
        bytes += chunk.byteLength;
        if (bytes > RESPONSE_MAX_BYTES) throw new Error('claude_response_too_large');
        controller.enqueue(chunk);
      },
    });
    return new Response(response.body.pipeThrough(stream), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

function textOf(message: BetaMessage): string | null {
  let text = '';
  for (const block of message.content) {
    const value = record(block);
    if (value?.['type'] === 'text' && typeof value['text'] === 'string') text += value['text'];
    else if (value?.['type'] !== 'thinking' && value?.['type'] !== 'redacted_thinking' && value?.['type'] !== 'fallback') return null;
  }
  return text;
}

function contributingModels(message: BetaMessage): string[] {
  const models: string[] = [];
  let textSinceFallback = false;
  for (const block of message.content) {
    const value = record(block);
    if (value?.['type'] === 'text' && typeof value['text'] === 'string' && value['text'] !== '') textSinceFallback = true;
    if (value?.['type'] === 'fallback') {
      const from = record(value['from'])?.['model'];
      if (textSinceFallback && typeof from === 'string' && from !== '' && !models.includes(from)) models.push(from);
      textSinceFallback = false;
    }
  }
  if (textSinceFallback && typeof message.model === 'string' && message.model !== '' && !models.includes(message.model)) models.push(message.model);
  return models;
}

function isApiError(error: unknown): error is APIError {
  return error instanceof APIError;
}

export async function generateClaude(request: GenerateRequest, context: ProviderContext): Promise<ProviderResult> {
  const opus = context.route.upstreamModel.startsWith('claude-opus');
  const parameters = {
    effort: request.effort || (opus ? 'medium' : 'low'),
    maxOutputTokens: request.maxOutputTokens || (opus ? 16_384 : 4096),
    allowFallback: request.allowFallback ?? false,
  };
  const base: ProviderResult = { output: '', reportedModel: '', usage: unknownUsage(), observations: { searched: false, openedUrls: [] } };
  const fail = (code: number, message: string): ProviderResult => ({ ...base, error: providerStatus(code, message) });
  if (!context.route.efforts.includes(parameters.effort)
    || !Number.isInteger(parameters.maxOutputTokens) || parameters.maxOutputTokens < 1 || parameters.maxOutputTokens > 128_000
    || request.instructions.filter(block => block.cache).length > 4) return fail(3, 'claude_unsupported_parameters');
  const key = apiKey(context, 'ANTHROPIC');
  if (key === null) return fail(9, 'claude_not_configured');
  let schema: Record<string, unknown> | null;
  try { schema = parseSchema(request.outputSchemaJson); } catch { return fail(3, 'output_schema_invalid'); }
  const upstreamRequest: MessageCreateParamsBase = {
    model: context.route.upstreamModel,
    max_tokens: parameters.maxOutputTokens,
    system: request.instructions.map(block => ({ type: 'text', text: block.text, ...(block.cache ? { cache_control: { type: 'ephemeral' as const, ttl: '5m' as const } } : {}) })),
    messages: [{ role: 'user', content: request.input }],
    ...(opus ? { thinking: { type: 'adaptive' as const } } : {}),
    output_config: { effort: parameters.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max', ...(schema === null ? {} : { format: { type: 'json_schema' as const, schema } }) },
    ...(parameters.allowFallback && opus ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
  };
  const deadline = deadlineSignal(context);
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  deadline.signal.addEventListener('abort', cancel, { once: true });
  if (deadline.signal.aborted) cancel();
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const beat = (): void => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => { stalled = true; controller.abort(); }, STALL_MS);
  };
  const client = new Anthropic({ apiKey: key, fetch: watchedFetch(context.fetcher, beat), maxRetries: 0, timeout: HEADER_TIMEOUT_MS, defaultHeaders: { 'anthropic-version': '2026-10-21' } });
  let partialUsage: Record<string, unknown> | null = null;
  let message: BetaMessage;
  try {
    if (context.deadlineMs - Date.now() > HEADER_TIMEOUT_MS || parameters.maxOutputTokens > 16_384) {
      const stream = client.beta.messages.stream(upstreamRequest, { signal: controller.signal });
      stream.on('streamEvent', event => {
        if (event.type === 'message_start') {
          base.reportedModel = event.message.model;
          partialUsage = record(event.message.usage);
        } else if (event.type === 'message_delta') {
          partialUsage = { ...partialUsage, ...record(event.usage) };
        }
      });
      message = await stream.finalMessage();
    } else {
      message = await client.beta.messages.create({ ...upstreamRequest, stream: false }, { signal: controller.signal });
    }
  } catch (error) {
    // Counts observed before interruption remain useful, but are not complete billing usage.
    const partial = claudeUsage(partialUsage, context.route.upstreamModel, base.reportedModel);
    base.usage = { ...partial, available: false };
    delete base.usage.estimatedCostMicrousd;
    if (context.signal.aborted) return timedOut(context.signal) ? fail(4, 'claude_deadline') : fail(1, 'claude_cancelled');
    if (deadline.signal.aborted) return fail(4, 'claude_deadline');
    if (stalled) return fail(4, 'claude_stream_stalled');
    if (error instanceof APIUserAbortError) return fail(1, 'claude_cancelled');
    if (error instanceof APIConnectionTimeoutError) return fail(4, 'claude_headers_timeout');
    if (isApiError(error) && error.status !== undefined && partialUsage === null) {
      if (refusedBeforeGeneration(error.status)) base.usage = zeroUsage();
      const body = record(error.error);
      const detail = record(body?.['error']) ?? body;
      const message = detail?.['message'];
      const spendLimit = record(detail?.['details'])?.['error_code'] === 'enforced_spend_limit_reached'
        || (typeof message === 'string' && /^(?:You have reached your specified (?:workspace )?API usage limits|Your credit balance is too low)\b/.test(message));
      if ((error.status === 400 || error.status === 429) && spendLimit) return { ...base, error: providerStatus(8, 'claude_spend_limit', 'MODEL_SPEND_LIMIT') };
      return { ...base, error: httpError('claude', error.status, error.headers) };
    }
    if (partialUsage !== null) return fail(14, 'claude_stream_interrupted');
    if (error instanceof APIConnectionError) return fail(14, 'claude_connection');
    return fail(13, 'claude_invalid_response');
  } finally {
    clearTimeout(stallTimer);
    deadline.signal.removeEventListener('abort', cancel);
    deadline.clear();
  }
  if (record(message) === null) return fail(13, 'claude_invalid_response');
  base.reportedModel = typeof message.model === 'string' ? message.model : '';
  base.usage = claudeUsage(message.usage, context.route.upstreamModel, base.reportedModel);
  if (!Array.isArray(message.content)) return fail(13, 'claude_invalid_response');
  base.contributingModels = contributingModels(message);
  if (message.stop_reason === 'refusal') return { ...base, error: providerStatus(9, 'claude_refused', 'MODEL_REFUSED') };
  if (message.stop_reason === 'max_tokens') return { ...base, error: providerStatus(13, 'claude_output_limit', 'MODEL_OUTPUT_LIMIT') };
  if (message.stop_reason !== 'end_turn') return fail(13, 'claude_incomplete');
  const output = textOf(message);
  if (output === null || output.trim() === '') return fail(13, 'claude_invalid_response');
  return { ...base, output };
}
