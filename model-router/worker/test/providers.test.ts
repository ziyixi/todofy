import { create } from '@ziyixi/proto/protobuf';
import { GenerateRequestSchema, type GenerateRequest } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderContext } from '../src/types.ts';
import { modelCatalog, routeFor } from '../src/catalog.ts';
import { generateClaude as invokeClaude } from '../src/providers/claude.ts';
import { apiKey, parseRetryAfter } from '../src/providers/common.ts';
import { generateGemini as invokeGemini } from '../src/providers/gemini.ts';
import { claudeUsage, estimateTokens, geminiUsage } from '../src/providers/usage.ts';
import { embedWorkersAI } from '../src/providers/workers-ai.ts';

const schema = { type: 'array', items: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } };

function config(value: Partial<Omit<GenerateRequest, '$typeName'>> = {}): GenerateRequest {
  return create(GenerateRequestSchema, { model: 'claude-opus-5-5', ...value });
}

function generateClaude(request: GenerateRequest, input: string, context: ProviderContext) { return invokeClaude({ ...request, input }, context); }
function generateGemini(request: GenerateRequest, input: string, context: ProviderContext) { return invokeGemini({ ...request, input }, context); }

function context(provider: 'anthropic' | 'gemini' | 'workers_ai', fetcher: typeof fetch = vi.fn()): ProviderContext {
  const name = provider === 'anthropic' ? 'claude-opus-5-5' : provider === 'gemini' ? 'gemini-3.8-flash' : '@cf/baai/bge-m3';
  return {
    env: { ANTHROPIC_API_KEY: 'synthetic-claude-key', GEMINI_API_KEY: 'synthetic-gemini-key' } as unknown as ProviderContext['env'],
    caller: 'mailsort', signal: new AbortController().signal,
    deadlineMs: Date.now() + 110_000, fetcher,
    route: routeFor(name),
  };
}

function requestBody(fetcher: typeof fetch): Record<string, unknown> {
  const body = vi.mocked(fetcher).mock.calls[0]?.[1]?.body;
  if (typeof body !== 'string') throw new Error('expected a synthetic JSON request');
  return JSON.parse(body) as Record<string, unknown>;
}

function claudeMessage(stop = 'end_turn') {
  return { id: 'synthetic-message', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'synthetic hidden reasoning' }, { type: 'text', text: '[{"value":"synthetic"}]' }], stop_reason: stop,
    usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens_details: { thinking_tokens: 12 } } };
}

function event(type: string, value: unknown): string { return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`; }

function streamResponse(options: { stop?: string; error?: boolean; stall?: boolean; signal?: AbortSignal } = {}): Response {
  const chunks = [
    event('message_start', { type: 'message_start', message: { ...claudeMessage(), content: [], usage: { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 20, cache_read_input_tokens: 30 } } }),
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'synthetic ' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 0 }),
    event('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' }, trigger: { type: 'refusal', category: 'synthetic' } } }),
    event('content_block_stop', { type: 'content_block_stop', index: 1 }),
    event('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }),
    event('content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'continuation' } }),
    event('content_block_stop', { type: 'content_block_stop', index: 2 }),
  ];
  if (options.error) chunks.push(event('error', { type: 'error', error: { type: 'overloaded_error', message: 'private provider text must not escape' } }));
  else if (!options.stall) chunks.push(
    event('message_delta', { type: 'message_delta', delta: { stop_reason: options.stop ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: 50 } }),
    event('message_stop', { type: 'message_stop' }),
  );
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach(chunk => controller.enqueue(encoder.encode(chunk)));
      if (options.stall) options.signal?.addEventListener('abort', () => controller.error(new Error('synthetic aborted')));
      else controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

function geminiMessage(finishReason = 'STOP') {
  return { modelVersion: 'gemini-3.7-flash-reported', candidates: [{ finishReason, content: { parts: [{ text: 'hidden reasoning', thought: true }, { text: '[{"value":"synthetic"}]' }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 30, thoughtsTokenCount: 20, cachedContentTokenCount: 10 } };
}

describe('Claude adapter', () => {
  it('preserves adaptive effort, cache blocks, schema, exact usage and shared credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(claudeMessage()));
    const result = await generateClaude(config({ instructions: [createInstruction('stable instructions', true)], outputSchemaJson: JSON.stringify(schema) }), 'synthetic input', context('anthropic', fetcher));
    const init = (vi.mocked(fetcher).mock.calls[0]?.[1]) as RequestInit;
    const body = requestBody(fetcher);
    expect(body).toMatchObject({ thinking: { type: 'adaptive' }, max_tokens: 16_384, system: [{ text: 'stable instructions', cache_control: { type: 'ephemeral', ttl: '5m' } }], output_config: { effort: 'medium', format: { type: 'json_schema', schema } } });
    expect(body['messages']).toEqual([{ role: 'user', content: 'synthetic input' }]);
    expect(new Headers(init.headers).get('x-api-key')).toBe('synthetic-claude-key');
    expect(result.error).toBeUndefined();
    expect(result.output).toBe('[{"value":"synthetic"}]');
    expect(result.usage).toMatchObject({ available: true, inputTokens: 150, outputTokens: 50, cachedInputTokens: 30, cacheWriteTokens: 20, estimatedCostMicrousd: 1506 });
  });

  it('collects long streams with server fallback into one final result', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse());
    const ctx = { ...context('anthropic', fetcher), deadlineMs: Date.now() + 780_000 };
    const result = await generateClaude(config({ ...{ allowFallback: true, maxOutputTokens: 64_000 } }), 'synthetic', ctx);
    expect(result.output).toBe('synthetic continuation');
    expect(result.contributingModels).toEqual(['claude-opus-5-5', 'claude-opus-5']);
    expect(result.error).toBeUndefined();
    const init = vi.mocked(fetcher).mock.calls[0]?.[1];
    expect(JSON.parse(init?.body as string)).toMatchObject({ stream: true, fallbacks: 'default' });
    expect(new Headers(init?.headers).get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
  });

  it('retains partial token counts without claiming complete usage after a stream error', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse({ error: true }));
    const result = await generateClaude(config({ ...{ maxOutputTokens: 64_000 } }), 'synthetic', context('anthropic', fetcher));
    expect(result.output).toBe('');
    expect(result.error?.message).toBe('claude_stream_interrupted');
    expect(result.usage).toMatchObject({ available: false, inputTokens: 150, cachedInputTokens: 30, cacheWriteTokens: 20 });
    expect(result.usage.estimatedCostMicrousd).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('private provider text');
  });

  it('aborts an unfinished stream by the invocation deadline', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => Promise.resolve(streamResponse({ stall: true, ...(init?.signal === undefined || init.signal === null ? {} : { signal: init.signal }) })));
    const result = await generateClaude(config({ ...{ maxOutputTokens: 64_000 } }), 'synthetic', { ...context('anthropic', fetcher), deadlineMs: Date.now() + 40 });
    expect(result.error?.message).toBe('claude_deadline');
    expect(result.usage.available).toBe(false);
    expect(result.output).toBe('');
  });

  it.each([['refusal', 'claude_refused'], ['max_tokens', 'claude_output_limit']])('keeps billable usage for %s', async (stop, message) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(claudeMessage(stop)));
    const result = await generateClaude(config(), 'synthetic', context('anthropic', fetcher));
    expect(result.error?.message).toBe(message);
    expect(result.output).toBe('');
    expect(result.usage.available).toBe(true);
  });

  it('rejects unsupported explicit controls before a provider call', async () => {
    const ctx = context('anthropic');
    const result = await generateClaude(config({ ...{ effort: 'unsupported' } }), 'synthetic', ctx);
    expect(result.error?.code).toBe(3);
    expect(ctx.fetcher).not.toHaveBeenCalled();
  });

  it('sends one user turn', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(claudeMessage()));
    await generateClaude(config(), 'synthetic user turn', context('anthropic', fetcher));
    expect(requestBody(fetcher)['messages']).toEqual([{ role: 'user', content: 'synthetic user turn' }]);
  });

  it('normalizes a confirmed API spend refusal separately from a rate limit', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { type: 'rate_limit_error', details: { error_code: 'enforced_spend_limit_reached' } } }, { status: 429 }));
    const result = await generateClaude(config(), 'synthetic', context('anthropic', fetcher));
    expect(result.error).toMatchObject({ code: 8, reason: 'MODEL_SPEND_LIMIT' });
    const credits = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the API.' } }, { status: 400 }));
    expect((await generateClaude(config(), 'synthetic', context('anthropic', credits))).error).toMatchObject({ code: 8, reason: 'MODEL_SPEND_LIMIT' });
  });

  it.each([[400, 3, 'MODEL_INVALID_REQUEST'], [413, 3, 'MODEL_INVALID_REQUEST'], [422, 3, 'MODEL_INVALID_REQUEST'], [404, 9, 'MODEL_NOT_CONFIGURED'], [401, 7, 'MODEL_AUTH']])('reports HTTP %s before generation as %s with zero billed usage', async (status, code, reason) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'private provider text' } }, { status }));
    const result = await generateClaude(config(), 'synthetic', context('anthropic', fetcher));
    expect(result.error).toMatchObject({ code, reason });
    expect(result.usage).toMatchObject({ available: true, inputTokens: 0, outputTokens: 0, estimatedCostMicrousd: 0 });
    expect(JSON.stringify(result)).not.toContain('private provider text');
  });

  it('reports the Router deadline as a timeout and only a real cancellation as cancelled', async () => {
    const hang = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('synthetic aborted')))));
    for (const [reason, code, expected] of [[new DOMException('deadline', 'TimeoutError'), 4, 'MODEL_TIMEOUT'], [undefined, 1, 'MODEL_CANCELLED']] as const) {
      const controller = new AbortController();
      const pending = generateClaude(config(), 'synthetic', { ...context('anthropic', hang), signal: controller.signal });
      setTimeout(() => controller.abort(reason), 10);
      expect((await pending).error).toMatchObject({ code, reason: expected });
    }
  });

  it('permits fallback on a Haiku route that has no fallback policy', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...claudeMessage(), model: 'claude-haiku-5-5' }));
    const ctx = { ...context('anthropic', fetcher), route: routeFor('claude-haiku-5-5') };
    const result = await generateClaude(config({ ...{ allowFallback: true } }), 'synthetic', ctx);
    expect(result.error).toBeUndefined();
    expect(requestBody(fetcher)['fallbacks']).toBeUndefined();
  });
});

function createInstruction(text: string, cache = false): GenerateRequest['instructions'][number] {
  return { $typeName: 'modelrouter.inference.v1.Instruction', text, cache };
}



describe('Gemini adapter', () => {
  it('preserves Retry-After from a quota response for the caller backoff', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: 'private provider message' } }, { status: 429, headers: { 'retry-after': '120' } }));
    const result = await generateGemini(config(), 'synthetic', context('gemini', fetcher));
    expect(result.error).toMatchObject({ code: 8, reason: 'MODEL_RATE_LIMIT', retryAfterSeconds: 120 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.output).toBe('');
  });

  it('uses standard schemas, excludes thoughts and preserves model defaults', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(geminiMessage()));
    const result = await generateGemini(config({ outputSchemaJson: JSON.stringify(schema) }), 'synthetic', context('gemini', fetcher));
    const body = requestBody(fetcher);
    expect(body['generationConfig']).toEqual({ responseMimeType: 'application/json', responseJsonSchema: schema });
    expect(result.output).toBe('[{"value":"synthetic"}]');
    expect(result.reportedModel).toBe('gemini-3.7-flash-reported');
    expect(result.usage).toMatchObject({ available: true, inputTokens: 100, outputTokens: 50, cachedInputTokens: 10 });
    expect(result.usage.estimatedCostMicrousd).toBeUndefined();
  });

  it('returns a rate limit after one actual-model request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { message: 'private provider message' } }, { status: 429 })).mockResolvedValueOnce(Response.json(geminiMessage()));
    const ctx = context('gemini', fetcher);
    const result = await generateGemini(config({ ...{ allowFallback: true, effort: 'low', maxOutputTokens: 4096 } }), 'synthetic', { ...ctx });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.error?.reason).toBe('MODEL_RATE_LIMIT');
    // A refusal before generation bills nothing.
    expect(result.usage).toMatchObject({ available: true, inputTokens: 0, outputTokens: 0, estimatedCostMicrousd: 0 });
  });

  it.each([408, 503])('keeps usage unknown after HTTP %s', async status => {
    const result = await generateGemini(config(), 'synthetic', context('gemini', vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }))));
    expect(result.error?.code).toBe(status === 408 ? 4 : 14);
    expect(result.usage.available).toBe(false);
  });

  it('reports an already expired Router deadline as a timeout', async () => {
    const result = await generateGemini(config(), 'synthetic', { ...context('gemini'), signal: AbortSignal.abort(new DOMException('deadline', 'TimeoutError')) });
    expect(result.error).toMatchObject({ code: 4, reason: 'MODEL_TIMEOUT' });
  });

  it.each([400, 401, 403])('does not try another model after HTTP %s', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: 'private body' } }, { status }));
    const ctx = context('gemini', fetcher);
    const result = await generateGemini(config({ ...{ allowFallback: true } }), 'synthetic', { ...ctx });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.error?.message).toBe(`gemini_http_${String(status)}`);
    expect(JSON.stringify(result)).not.toContain('private body');
  });

  it('reports no provider model when the response omits modelVersion', async () => {
    const reply: Record<string, unknown> = geminiMessage();
    delete reply['modelVersion'];
    const result = await generateGemini(config(), 'synthetic', context('gemini', vi.fn<typeof fetch>().mockResolvedValue(Response.json(reply))));
    expect(result.reportedModel).toBe('');
  });

  it('does not return truncated output as a success', async () => {
    const result = await generateGemini(config(), 'synthetic', context('gemini', vi.fn<typeof fetch>().mockResolvedValue(Response.json(geminiMessage('MAX_TOKENS')))));
    expect(result.output).toBe('');
    expect(result.error?.message).toBe('gemini_output_limit');
    expect(result.usage.available).toBe(true);
  });

  it('makes one native request when fallback is permitted', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(geminiMessage()));
    const result = await generateGemini(config({ allowFallback: true }), 'synthetic user turn', context('gemini', fetcher));
    expect(result.error).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requestBody(fetcher)['contents']).toEqual([{ role: 'user', parts: [{ text: 'synthetic user turn' }] }]);
  });
});

describe('provider isolation and usage', () => {
  it('keeps Retry-After delta/date semantics and the existing daily ceiling', () => {
    const now = Date.parse('2026-10-26T12:00:00Z');
    expect(parseRetryAfter('+12', now)).toBe(12);
    expect(parseRetryAfter(new Date(now + 120_000).toUTCString(), now)).toBe(120);
    expect(parseRetryAfter(new Date(now - 120_000).toUTCString(), now)).toBe(0);
    expect(parseRetryAfter('invalid', now)).toBe(0);
    expect(parseRetryAfter('-12', now)).toBe(0);
    expect(parseRetryAfter('999999', now)).toBe(86_400);
  });

  it('uses the same provider key for every authenticated calling app', () => {
    const ctx = context('anthropic');
    for (const caller of ['console', 'mailsort', 'todofy', 'brief', 'newsletter']) {
      expect(apiKey({ ...ctx, caller }, 'ANTHROPIC')).toBe('synthetic-claude-key');
      expect(apiKey({ ...ctx, caller }, 'GEMINI')).toBe('synthetic-gemini-key');
    }
    expect(apiKey({ ...ctx, env: {} as ProviderContext['env'] }, 'ANTHROPIC')).toBeNull();
  });

  it('reports one shared catalog connection and requires the executor Access identity', () => {
    const ctx = context('anthropic');
    const models = modelCatalog(ctx.env);
    expect(models.filter(model => model.provider === 'anthropic' || model.provider === 'google').every(model => model.configured)).toBe(true);
    const executor = (modelCatalog({ ...ctx.env, CODEX_EXECUTOR_ORIGIN: 'https://synthetic-executor.example', CODEX_ACCESS_CLIENT_ID: 'synthetic-id', CODEX_ACCESS_CLIENT_SECRET: 'synthetic-secret' })).find(model => model.provider === 'openai');
    expect(executor?.configured).toBe(true);
  });

  it('prices Claude fallback iterations at their own rates and handles cache TTLs', () => {
    const usage = claudeUsage({ iterations: [
      { type: 'message', input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 10 } },
      { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 30 },
    ] }, 'claude-opus-5-5', 'claude-opus-5');
    expect(usage).toMatchObject({ available: true, inputTokens: 350, outputTokens: 30, cacheWriteTokens: 20, cachedInputTokens: 30, estimatedCostMicrousd: 2245 });
    expect(claudeUsage({ input_tokens: 100, output_tokens: 20 }, 'unknown', 'unknown').estimatedCostMicrousd).toBeUndefined();
  });

  it('distinguishes missing usage from reported zero and prevents counting reasoning twice', () => {
    expect(geminiUsage(undefined).available).toBe(false);
    expect(geminiUsage({ promptTokenCount: 0, candidatesTokenCount: 0 }).available).toBe(true);
    expect(claudeUsage({ input_tokens: 10, output_tokens: 50, output_tokens_details: { thinking_tokens: 20 } }, 'claude-opus-5-5', 'claude-opus-5-5').outputTokens).toBe(50);
  });
});

describe('Workers AI embeddings', () => {
  it('returns 1024-dimensional vectors in input order and leaves unreported usage unknown', async () => {
    const run = vi.fn(() => Promise.resolve({ data: [Array<number>(1024).fill(1), Array<number>(1024).fill(2)] }));
    const ctx = context('workers_ai');
    const result = await embedWorkersAI(['first synthetic', 'second synthetic'], { ...ctx, env: { AI: { run } } as unknown as ProviderContext['env'] });
    expect(run).toHaveBeenCalledWith('@cf/baai/bge-m3', { text: ['first synthetic', 'second synthetic'] });
    expect(result.vectors.map(vector => vector[0])).toEqual([1, 2]);
    expect(result.vectors.every(vector => vector.length === 1024)).toBe(true);
    expect(result.usage).toMatchObject({ available: false, billingKind: 'platform_quota' });
    expect(result.usage.estimatedQuotaUnits).toBeCloseTo(0.01075);
  });

  it('keeps the retained CJK/3.5 estimate separate from reported consumption', () => {
    expect(estimateTokens('abcd中文')).toBe(4);
  });

  it('rejects incorrect dimensions instead of returning partial vectors', async () => {
    const ctx = context('workers_ai');
    const result = await embedWorkersAI(['synthetic'], { ...ctx, env: { AI: { run: () => Promise.resolve({ data: [[1, 2]] }) } } as unknown as ProviderContext['env'] });
    expect(result.vectors).toEqual([]);
    expect(result.error?.message).toBe('embedding_invalid_response');
  });

  it('reports its own expired deadline as a timeout', async () => {
    const ctx = context('workers_ai');
    const run = vi.fn(() => Promise.resolve({ data: [Array<number>(1024).fill(1)] }));
    const result = await embedWorkersAI(['synthetic'], { ...ctx, env: { AI: { run } } as unknown as ProviderContext['env'], signal: AbortSignal.abort(new DOMException('deadline', 'TimeoutError')) });
    expect(result.error).toMatchObject({ code: 4, reason: 'MODEL_TIMEOUT' });
    expect(run).not.toHaveBeenCalled();
  });

  it('recognizes platform quota errors without exposing their content', async () => {
    const ctx = context('workers_ai');
    const result = await embedWorkersAI(['synthetic'], { ...ctx, env: { AI: { run: () => Promise.reject(new Error('4006 quota: private provider message')) } } as unknown as ProviderContext['env'] });
    expect(result.error?.code).toBe(8);
    expect(JSON.stringify(result)).not.toContain('private provider message');
  });
});
