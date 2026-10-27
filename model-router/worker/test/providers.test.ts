import { create } from '@ziyixi/proto/protobuf';
import { GenerationConfigSchema, type GenerationConfig } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderContext } from '../src/types.ts';
import { routeFor } from '../src/catalog.ts';
import { generateClaude } from '../src/providers/claude.ts';
import { apiKey } from '../src/providers/common.ts';
import { generateGemini } from '../src/providers/gemini.ts';
import { claudeUsage, geminiUsage } from '../src/providers/usage.ts';
import { embedWorkersAI } from '../src/providers/workers-ai.ts';

const schema = { type: 'array', items: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } };

function config(value: Partial<Omit<GenerationConfig, '$typeName'>> = {}): GenerationConfig {
  return create(GenerationConfigSchema, { model: 'models/claude-opus-5-5', ...value });
}

function context(provider: 'anthropic' | 'gemini' | 'workers_ai', fetcher: typeof fetch = vi.fn()): ProviderContext {
  const name = provider === 'anthropic' ? 'models/claude-opus-5-5' : provider === 'gemini' ? 'models/gemini-3-8-flash' : 'models/bge-m3';
  return {
    env: { ANTHROPIC_API_KEY_MAILSORT: 'synthetic-claude-key', GEMINI_API_KEY_MAILSORT: 'synthetic-gemini-key' } as unknown as ProviderContext['env'],
    caller: 'mailsort', requestId: '00000000-0000-4000-8000-000000000001', signal: new AbortController().signal,
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
  it('preserves adaptive effort, cache blocks, schema, exact usage and caller credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(claudeMessage()));
    const result = await generateClaude(config({ instructions: [createInstruction('stable instructions', true)], outputSchemaJson: JSON.stringify(schema) }), 'synthetic input', context('anthropic', fetcher));
    const init = (vi.mocked(fetcher).mock.calls[0]?.[1]) as RequestInit;
    const body = requestBody(fetcher);
    expect(body).toMatchObject({ thinking: { type: 'adaptive' }, max_tokens: 16_384, system: [{ text: 'stable instructions', cache_control: { type: 'ephemeral', ttl: '5m' } }], output_config: { effort: 'medium', format: { type: 'json_schema', schema } } });
    expect(body['messages']).toEqual([{ role: 'user', content: 'synthetic input' }]);
    expect(new Headers(init.headers).get('x-api-key')).toBe('synthetic-claude-key');
    expect(result.error).toBeUndefined();
    expect(result.output).toBe('[{"value":"synthetic"}]');
    expect(result.usage).toMatchObject({ available: true, inputTokens: 150, outputTokens: 50, cachedInputTokens: 30, cacheWriteTokens: 20, reasoningOutputTokens: 12, estimatedCostMicrousd: 1506 });
  });

  it('collects long streams with server fallback into one final result', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse());
    const ctx = { ...context('anthropic', fetcher), deadlineMs: Date.now() + 780_000 };
    const result = await generateClaude(config({ parameters: createParameters({ allowFallback: true, maxOutputTokens: 64_000 }) }), 'synthetic', ctx);
    expect(result.output).toBe('synthetic continuation');
    expect(result.contributingModels).toEqual(['claude-opus-5-5', 'claude-opus-5']);
    expect(result).toMatchObject({ upstreamStarted: true, attemptCount: 1, finishReason: 'complete' });
    expect(result.error).toBeUndefined();
    const init = vi.mocked(fetcher).mock.calls[0]?.[1];
    expect(JSON.parse(init?.body as string)).toMatchObject({ stream: true, fallbacks: 'default' });
    expect(new Headers(init?.headers).get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
  });

  it('retains partial token counts without claiming complete usage after a stream error', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(streamResponse({ error: true }));
    const result = await generateClaude(config({ parameters: createParameters({ maxOutputTokens: 64_000 }) }), 'synthetic', context('anthropic', fetcher));
    expect(result.output).toBe('');
    expect(result.error?.message).toBe('claude_stream_interrupted');
    expect(result.usage).toMatchObject({ available: false, inputTokens: 150, cachedInputTokens: 30, cacheWriteTokens: 20 });
    expect(result.usage.estimatedCostMicrousd).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('private provider text');
  });

  it('aborts an unfinished stream by the invocation deadline', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => Promise.resolve(streamResponse({ stall: true, ...(init?.signal === undefined || init.signal === null ? {} : { signal: init.signal }) })));
    const result = await generateClaude(config({ parameters: createParameters({ maxOutputTokens: 64_000 }) }), 'synthetic', { ...context('anthropic', fetcher), deadlineMs: Date.now() + 40 });
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
    const result = await generateClaude(config({ parameters: createParameters({ temperature: 0.2 }) }), 'synthetic', ctx);
    expect(result.error?.code).toBe(3);
    expect(ctx.fetcher).not.toHaveBeenCalled();
  });

  it('keeps conversation roles separate from the current turn', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(claudeMessage()));
    await generateClaude(config(), 'second user turn', { ...context('anthropic', fetcher), history: [{ role: 'user', content: 'first user turn' }, { role: 'assistant', content: 'first assistant turn' }] });
    expect(requestBody(fetcher)['messages']).toEqual([
      { role: 'user', content: 'first user turn' }, { role: 'assistant', content: 'first assistant turn' }, { role: 'user', content: 'second user turn' },
    ]);
  });

  it('normalizes a confirmed API spend refusal separately from a rate limit', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { type: 'rate_limit_error', details: { error_code: 'enforced_spend_limit_reached' } } }, { status: 429 }));
    const result = await generateClaude(config(), 'synthetic', context('anthropic', fetcher));
    expect(result.error).toMatchObject({ code: 8, reason: 'MODEL_SPEND_LIMIT' });
    expect(result).toMatchObject({ upstreamStarted: false, attemptCount: 1 });
  });

  it('permits fallback on a Haiku route that has no fallback policy', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...claudeMessage(), model: 'claude-haiku-5-5' }));
    const ctx = { ...context('anthropic', fetcher), route: routeFor('models/claude-haiku-5-5') };
    const result = await generateClaude(config({ parameters: createParameters({ allowFallback: true }) }), 'synthetic', ctx);
    expect(result.error).toBeUndefined();
    expect(requestBody(fetcher)['fallbacks']).toBeUndefined();
  });
});

function createInstruction(text: string, cache = false): GenerationConfig['instructions'][number] {
  return { $typeName: 'modelrouter.inference.v1.Instruction', text, cache };
}

function createParameters(value: Partial<NonNullable<GenerationConfig['parameters']>>): NonNullable<GenerationConfig['parameters']> {
  return { $typeName: 'modelrouter.inference.v1.Parameters', effort: '', allowFallback: false, ...value };
}

describe('Gemini adapter', () => {
  it('uses standard schemas, excludes thoughts and preserves model defaults', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(geminiMessage()));
    const result = await generateGemini(config({ outputSchemaJson: JSON.stringify(schema) }), 'synthetic', context('gemini', fetcher));
    const body = requestBody(fetcher);
    expect(body['generationConfig']).toEqual({ responseMimeType: 'application/json', responseJsonSchema: schema });
    expect(result.output).toBe('[{"value":"synthetic"}]');
    expect(result.reportedModel).toBe('gemini-3.7-flash-reported');
    expect(result.usage).toMatchObject({ available: true, inputTokens: 100, outputTokens: 50, reasoningOutputTokens: 20, cachedInputTokens: 10 });
    expect(result.usage.estimatedCostMicrousd).toBeUndefined();
  });

  it('tries only the configured fallback chain and keeps unknown failed-attempt usage explicit', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ error: { message: 'private provider message' } }, { status: 429 })).mockResolvedValueOnce(Response.json(geminiMessage()));
    const ctx = context('gemini', fetcher);
    const result = await generateGemini(config({ parameters: createParameters({ allowFallback: true, effort: 'low', temperature: 0.3, maxOutputTokens: 4096 }) }), 'synthetic', { ...ctx, route: { ...ctx.route, fallbackModels: ['gemini-3.7-flash', 'gemini-3.5-flash-lite'] } });
    expect(vi.mocked(fetcher).mock.calls.map(call => call[0])).toEqual(['https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent']);
    expect(result.error).toBeUndefined();
    expect(result.usage.available).toBe(false);
    expect(result.usage.inputTokens).toBe(100);
    expect(requestBody(fetcher)['generationConfig']).toMatchObject({ thinkingConfig: { thinkingLevel: 'LOW' }, temperature: 0.3, maxOutputTokens: 4096 });
  });

  it.each([400, 401, 403])('does not try another model after HTTP %s', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: 'private body' } }, { status }));
    const ctx = context('gemini', fetcher);
    const result = await generateGemini(config({ parameters: createParameters({ allowFallback: true }) }), 'synthetic', { ...ctx, route: { ...ctx.route, fallbackModels: ['gemini-3.7-flash'] } });
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

  it('permits fallback on a plain route and maps assistant history to model turns', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(geminiMessage()));
    const result = await generateGemini(config({ parameters: createParameters({ allowFallback: true }) }), 'second user turn', { ...context('gemini', fetcher), history: [{ role: 'user', content: 'first user turn' }, { role: 'assistant', content: 'first assistant turn' }] });
    expect(result.error).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requestBody(fetcher)['contents']).toEqual([
      { role: 'user', parts: [{ text: 'first user turn' }] }, { role: 'model', parts: [{ text: 'first assistant turn' }] }, { role: 'user', parts: [{ text: 'second user turn' }] },
    ]);
  });
});

describe('provider isolation and usage', () => {
  it('never falls back to another application credential', () => {
    const ctx = context('anthropic');
    expect(apiKey({ ...ctx, caller: 'brief' }, 'ANTHROPIC')).toBeNull();
    const env = { ANTHROPIC_API_KEY: 'synthetic-global-key', ANTHROPIC_API_KEY_CONSOLE: 'synthetic-console-key' } as unknown as ProviderContext['env'];
    expect(apiKey({ ...ctx, env, caller: 'brief' }, 'ANTHROPIC')).toBeNull();
    expect(apiKey({ ...ctx, env, caller: 'console' }, 'ANTHROPIC')).toBe('synthetic-console-key');
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
    expect(result.dimensions).toBe(1024);
    expect(result.usage).toMatchObject({ available: false, billingKind: 'platform_quota' });
  });

  it('rejects incorrect dimensions instead of returning partial vectors', async () => {
    const ctx = context('workers_ai');
    const result = await embedWorkersAI(['synthetic'], { ...ctx, env: { AI: { run: () => Promise.resolve({ data: [[1, 2]] }) } } as unknown as ProviderContext['env'] });
    expect(result.vectors).toEqual([]);
    expect(result.error?.message).toBe('embedding_invalid_response');
  });

  it('recognizes platform quota errors without exposing their content', async () => {
    const ctx = context('workers_ai');
    const result = await embedWorkersAI(['synthetic'], { ...ctx, env: { AI: { run: () => Promise.reject(new Error('4006 quota: private provider message')) } } as unknown as ProviderContext['env'] });
    expect(result.error?.code).toBe(8);
    expect(JSON.stringify(result)).not.toContain('private provider message');
  });
});
