import { create } from '@ziyixi/proto/protobuf';
import { GenerateRequestSchema, InstructionSchema, type GenerateRequest } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import { describe, expect, it, vi } from 'vitest';
import { modelCatalog, providerFor, routeFor } from '../src/catalog.ts';
import { generateOpenAI } from '../src/providers/openai.ts';
import { openaiUsage } from '../src/providers/usage.ts';
import { validateConfig } from '../src/schema.ts';
import type { ProviderContext } from '../src/types.ts';

const model = 'openai/gpt-6.1-sol';
function request(value: Partial<Omit<GenerateRequest, '$typeName'>> = {}) {
  return create(GenerateRequestSchema, { model, input: 'Synthetic input', ...value });
}
function context(fetcher: typeof fetch = vi.fn()): ProviderContext {
  return { env: { OPENAI_API_KEY: 'synthetic-openai-key' } as ProviderContext['env'], caller: 'todofy',
    signal: new AbortController().signal, deadlineMs: Date.now() + 110_000, route: routeFor(model), fetcher };
}
function usage() {
  return { input_tokens: 100, output_tokens: 50, total_tokens: 150,
    input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10, cache_write_tokens_details: { ttl_30m_tokens: 6, ttl_12h_tokens: 4 } },
    output_tokens_details: { reasoning_tokens: 30 } };
}
function response(value: Record<string, unknown> = {}) {
  return { model: 'gpt-6.1-sol', status: 'completed', service_tier: 'default', usage: usage(),
    output: [{ type: 'reasoning', summary: [{ text: 'Synthetic hidden reasoning' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"answer":"synthetic"}' }] }], ...value };
}

describe('OpenAI Responses adapter', () => {
  it('uses one native Responses call, a shared Router key and the existing flat options', async () => {
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response()));
    const result = await generateOpenAI(request({ instructions: [create(InstructionSchema, { text: 'Synthetic rules', cache: true }), create(InstructionSchema, { text: 'Synthetic context' })],
      effort: 'max', maxOutputTokens: 1200, outputSchemaJson: JSON.stringify(schema), allowFallback: true }), context(fetcher));
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-openai-key');
    expect(init?.redirect).toBe('manual');
    const body = init?.body;
    if (typeof body !== 'string') throw new Error('Expected a synthetic JSON request body');
    expect(JSON.parse(body) as unknown).toEqual({ model: 'gpt-6.1-sol', input: 'Synthetic input', stream: false, store: false,
      service_tier: 'default', instructions: 'Synthetic rules\n\nSynthetic context', reasoning: { effort: 'max' }, max_output_tokens: 1200,
      text: { format: { type: 'json_schema', name: 'router_output', strict: true, schema } } });
    expect(result).toMatchObject({ output: '{"answer":"synthetic"}', reportedModel: 'gpt-6.1-sol', contributingModels: ['gpt-6.1-sol'],
      observations: { searched: false, openedUrls: [] },
      usage: { available: true, inputTokens: 100, outputTokens: 50, cachedInputTokens: 20, cacheWriteTokens: 10, billingKind: 'api', estimatedCostMicrousd: 677 } });
    expect(result.error).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('Synthetic hidden reasoning');
  });

  it.each([
    ['credit_balance_exhausted', 429, 'MODEL_SPEND_LIMIT'],
    ['insufficient_quota', 400, 'MODEL_SPEND_LIMIT'],
    ['organization_spend_limit_exceeded', 429, 'MODEL_SPEND_LIMIT'],
    ['project_spend_limit_exceeded', 429, 'MODEL_SPEND_LIMIT'],
    ['organization_usage_limit_exceeded', 429, 'MODEL_SPEND_LIMIT'],
    ['usage_limit_exceeded', 429, 'MODEL_SPEND_LIMIT'],
    ['rate_limit_exceeded', 429, 'MODEL_RATE_LIMIT'],
    ['invalid_json_schema', 400, 'MODEL_INVALID_REQUEST'],
    ['invalid_api_key', 401, 'MODEL_AUTH'],
    ['server_error', 500, 'MODEL_UNAVAILABLE'],
  ])('maps %s without exposing provider messages', async (code, status, reason) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code, message: 'Synthetic private provider message' } },
      { status, headers: { 'retry-after': '12' } }));
    const result = await generateOpenAI(request(), context(fetcher));
    expect(result.error?.reason).toBe(reason);
    if (reason === 'MODEL_RATE_LIMIT') expect(result.error?.retryAfterSeconds).toBe(12);
    expect(result.usage.available).toBe(status < 500);
    expect(result.usage.estimatedCostMicrousd).toBe(status < 500 ? 0 : undefined);
    expect(JSON.stringify(result)).not.toContain('Synthetic private provider message');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }, 'MODEL_OUTPUT_LIMIT'],
    [{ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }, 'MODEL_REFUSED'],
    [{ output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'Synthetic refusal' }] }] }, 'MODEL_REFUSED'],
    [{ status: 'failed', error: { code: 'server_error' } }, 'MODEL_UNAVAILABLE'],
    [{ output: [{ type: 'function_call', name: 'unexpected' }] }, 'MODEL_INVALID_ANSWER'],
    [{ output: [] }, 'MODEL_INVALID_ANSWER'],
  ])('retains consumed usage when output fails: %j', async (value, reason) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response(value)));
    const result = await generateOpenAI(request(), context(fetcher));
    expect(result.output).toBe('');
    expect(result.error?.reason).toBe(reason);
    expect(result.usage).toMatchObject({ available: true, inputTokens: 100, outputTokens: 50, estimatedCostMicrousd: 677 });
  });

  it('retains reported partial counts on an incomplete or failed reply', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response({ status: 'failed', error: { code: 'server_error' },
      usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 0 } } })));
    const result = await generateOpenAI(request(), context(fetcher));
    expect(result.error?.reason).toBe('MODEL_UNAVAILABLE');
    expect(result.usage).toMatchObject({ available: false, inputTokens: 100, cachedInputTokens: 20 });
    expect(result.usage.estimatedCostMicrousd).toBeUndefined();
  });

  it('leaves missing usage and missing upstream model unknown', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response({ model: undefined, usage: undefined })));
    const result = await generateOpenAI(request(), context(fetcher));
    expect(result.reportedModel).toBe('');
    expect(result.contributingModels).toEqual([]);
    expect(result.usage.available).toBe(false);
    expect(result.usage.estimatedCostMicrousd).toBeUndefined();
  });

  it('fails configuration, invalid schema and expired/cancelled calls before HTTP', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const ctx = context(fetcher);
    expect((await generateOpenAI(request(), { ...ctx, env: {} as ProviderContext['env'] })).error?.reason).toBe('MODEL_NOT_CONFIGURED');
    expect((await generateOpenAI(request({ outputSchemaJson: '{' }), ctx)).error?.reason).toBe('MODEL_INVALID_REQUEST');
    expect((await generateOpenAI(request(), { ...ctx, deadlineMs: Date.now() - 1 })).error?.reason).toBe('MODEL_TIMEOUT');
    expect((await generateOpenAI(request(), { ...ctx, signal: AbortSignal.abort() })).error?.reason).toBe('MODEL_CANCELLED');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses the Router deadline during HTTP and retains unknown usage on transport failure', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('Synthetic abort')));
      }));
      const pending = generateOpenAI(request(), { ...context(fetcher), deadlineMs: Date.now() + 1000 });
      await vi.advanceTimersByTimeAsync(1001);
      const result = await pending;
      expect(result.error?.reason).toBe('MODEL_TIMEOUT');
      expect(result.usage.available).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it.each([new Response('{'), new Response('x'.repeat(4 * 1024 * 1024 + 1))])('bounds and validates provider JSON', async value => {
    const result = await generateOpenAI(request(), context(vi.fn<typeof fetch>().mockResolvedValue(value)));
    expect(result.error?.reason).toBe('MODEL_INVALID_ANSWER');
  });
});

describe('Codex and API model identity', () => {
  it('keeps subscription and API IDs distinct and checks their own connections', () => {
    const catalog = modelCatalog(context().env);
    expect(catalog.find(item => item.id === 'gpt-6.1-sol')).toMatchObject({ provider: 'codex', configured: false });
    expect(catalog.filter(item => item.provider === 'openai').map(item => item.id)).toEqual([
      'openai/gpt-6-astra', model, 'openai/gpt-6.1-terra', 'openai/gpt-6-luna',
    ]);
    expect(catalog.filter(item => item.provider === 'openai').every(item => item.configured)).toBe(true);
    expect(routeFor('gpt-6.1-sol').provider).toBe('codex');
    expect(routeFor(model)).toMatchObject({ provider: 'openai', upstreamModel: 'gpt-6.1-sol' });
    expect(providerFor('gpt-6.1-sol')).toBe('codex');
    expect(providerFor(model)).toBe('openai');
    expect(() => routeFor('gpt-6-astra')).toThrow();
    expect(() => validateConfig(request({ model: 'openai/gpt-6.1-terra', effort: 'none', maxOutputTokens: 100 }))).not.toThrow();
    expect(() => validateConfig(request({ effort: 'none' }))).toThrow();
    expect(() => validateConfig(request({ model: 'gpt-6.1-sol', maxOutputTokens: 100 }))).toThrow();
  });
});

describe('OpenAI usage and Standard price estimates', () => {
  it.each([
    ['gpt-6-astra', 3395], ['gpt-6.1-sol', 677], ['gpt-6.1-terra', 339], ['gpt-6-luna', 34],
  ])('prices %s and counts reasoning only once', (reported, cost) => {
    expect(openaiUsage(usage(), reported, 'default')).toMatchObject({ available: true, outputTokens: 50, estimatedCostMicrousd: cost });
  });
  it('prices the full API request at the long-context rate', () => {
    expect(openaiUsage({ ...usage(), input_tokens: 300_000, total_tokens: 300_050 }, 'gpt-6.1-sol', 'default').estimatedCostMicrousd).toBe(1_200_704);
  });
  it('keeps unknown prices, tiers, cache write lifetimes and incomplete counts unpriced', () => {
    for (const value of [openaiUsage(usage(), 'unreported-snapshot', 'default'), openaiUsage(usage(), 'gpt-6.1-sol', 'priority'),
      openaiUsage({ ...usage(), input_tokens_details: { cached_tokens: 20, cache_write_tokens: 10 } }, 'gpt-6.1-sol', 'default'),
      openaiUsage({ ...usage(), output_tokens: undefined }, 'gpt-6.1-sol', 'default')]) expect(value.estimatedCostMicrousd).toBeUndefined();
    expect(openaiUsage({ ...usage(), total_tokens: 151 }, 'gpt-6.1-sol', 'default').available).toBe(false);
    expect(openaiUsage(undefined, 'gpt-6.1-sol', 'default').available).toBe(false);
    expect(openaiUsage({ input_tokens: 0, output_tokens: 0, total_tokens: 0,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } }, 'gpt-6.1-sol', 'default')).toMatchObject({ available: true, estimatedCostMicrousd: 0 });
  });
});
