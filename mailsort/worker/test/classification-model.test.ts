import { describe, expect, it, vi } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { GenerateRequestSchema, GenerationSchema, type Generation } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import { classifyEmails, ClassificationError } from '../src/classification-model.ts';
import { CLASSIFIER_MODELS } from '../src/classifier-config.ts';

const EMAILS = [{ id: 'synthetic-a', subject: '合成汇总', sender: '[address]', received_at: '2026-10-01T00:00:00Z', evaluated_at: '2026-10-01T01:00:00Z', time_zone: 'America/Los_Angeles', body: '合成数据。', body_truncated: false }];
const PROMPT = { basePrompt: 'Synthetic base instructions.', personalRules: 'Synthetic personal rules.' };
const ITEMS = [{ id: 'synthetic-a', bucket: 'P3', reason: '合成汇总适合周末核对。' }];
function binding(overrides: Partial<Omit<Generation, '$typeName' | '$unknown'>> = {}) {
  return { fetch: vi.fn(async (request: Request) => {
    const input = fromWire(GenerateRequestSchema, await request.clone().json()).message;
    return Response.json(toWire(GenerationSchema, create(GenerationSchema, {
      name: `requests/${crypto.randomUUID()}`, model: input.model, output: JSON.stringify({ items: ITEMS }),
      usage: { available: true, inputTokens: 150, outputTokens: 50, cachedInputTokens: 30, cacheWriteTokens: 20, estimatedCostMicrousd: 1506, billingKind: 'api' }, ...overrides,
    })));
  }) };
}

describe('Mailsort Model Router calls', () => {
  it('sends the saved API route and effort and keeps reported API cost', async () => {
    const router = binding();
    const result = await classifyEmails(router, 'openai', EMAILS, PROMPT, { classificationModel: 'openai/gpt-6.1-sol', classificationEffort: 'high' });
    const sent = fromWire(GenerateRequestSchema, await router.fetch.mock.calls[0]?.[0].clone().json()).message;
    expect(sent).toMatchObject({ model: 'openai/gpt-6.1-sol', effort: 'high', allowFallback: false });
    expect(result).toMatchObject({ model: 'openai/gpt-6.1-sol', costMicros: 1506 });
  });

  it.each(['claude', 'codex'] as const)('uses one common structured call for the saved %s selection', async provider => {
    const router = binding();
    const result = await classifyEmails(router, provider, EMAILS, PROMPT);
    const request = router.fetch.mock.calls[0]?.[0];
    expect(request?.url).toBe('https://model-router.internal/api/model/v1/generations:generate');
    expect(request?.headers.get('authorization')).toBeNull();
    const sent = fromWire(GenerateRequestSchema, await request?.clone().json()).message;
    expect(sent.model).toBe(CLASSIFIER_MODELS[provider]);
    // Never a cache hint; reported cache reads and writes are still counted below.
    expect(sent.instructions.map(block => ({ text: block.text, cache: block.cache }))).toEqual([
      { text: PROMPT.basePrompt, cache: false }, { text: PROMPT.personalRules, cache: false },
    ]);
    expect(sent).toMatchObject({ effort: 'medium', allowFallback: false });
    expect(sent.maxOutputTokens).toBe(0);
    expect(JSON.parse(sent.input)).toEqual({ emails: EMAILS });
    expect(JSON.parse(sent.outputSchemaJson)).toMatchObject({ properties: { items: { items: { required: ['id', 'bucket', 'reason'] } } } });
    expect(result).toMatchObject({ items: [{ id: 'synthetic-a', bucket: 'P3' }], costMicros: 1506, inputTokens: 150, cacheWriteTokens: 20, cacheReadTokens: 30, thinkingTokens: null });
  });

  it.each([
    ['MODEL_AUTH', 16, 'configuration', 'auth'], ['MODEL_NOT_CONFIGURED', 9, 'configuration', 'not_configured'],
    ['MODEL_NOT_ALLOWED', 7, 'configuration', 'not_allowed'], ['MODEL_SPEND_LIMIT', 8, 'configuration', 'spend_limit'],
    ['MODEL_INVALID_REQUEST', 3, 'content', 'bad_input'], ['MODEL_INVALID_ANSWER', 13, 'content', 'bad_answer'], ['MODEL_REFUSED', 9, 'content', 'bad_answer'],
    ['MODEL_OUTPUT_LIMIT', 13, 'content', 'bad_answer'], ['MODEL_UNSUPPORTED_TOOL', 13, 'content', 'bad_input'],
    ['MODEL_TIMEOUT', 4, 'timeout', 'timeout'], ['MODEL_CANCELLED', 1, 'infrastructure', 'unavailable'],
    ['MODEL_QUOTA', 8, 'infrastructure', 'quota'], ['MODEL_RATE_LIMIT', 8, 'infrastructure', 'rate_limit'], ['MODEL_UNAVAILABLE', 14, 'infrastructure', 'unavailable'],
    ['MODEL_BUSY', 14, 'infrastructure', 'unavailable'], ['MODEL_MAINTENANCE', 14, 'infrastructure', 'unavailable'],
    ['MODEL_STORAGE_UNAVAILABLE', 14, 'infrastructure', 'unavailable'], ['MODEL_INTERNAL', 13, 'infrastructure', 'unavailable'],
    // A reason this build does not know goes by its google.rpc.Code.
    ['MODEL_SYNTHETIC_NEW', 3, 'content', 'bad_input'], ['MODEL_SYNTHETIC_NEW', 7, 'configuration', 'not_allowed'],
    ['MODEL_SYNTHETIC_NEW', 9, 'configuration', 'not_configured'], ['MODEL_SYNTHETIC_NEW', 16, 'configuration', 'auth'],
    ['MODEL_SYNTHETIC_NEW', 4, 'timeout', 'timeout'], ['MODEL_SYNTHETIC_NEW', 8, 'infrastructure', 'unavailable'],
  ] as const)('classifies %s (code %i) as %s by the shared contract', async (reason, code, kind, suffix) => {
    const router = binding({ output: '', error: { $typeName: 'modelrouter.inference.v1.ModelError', code, reason, message: 'Safe synthetic failure.', retryAfterSeconds: 0 } });
    const error = await classifyEmails(router, 'claude', EMAILS, PROMPT).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ClassificationError);
    expect(error).toMatchObject({ kind, code: `claude_${suffix}`, spendLimited: reason === 'MODEL_SPEND_LIMIT', quota: reason === 'MODEL_QUOTA', retryAfterMs: 0, usage: { inputTokens: 150, costMicros: 1506 } });
  });

  it('keeps the Router\'s Retry-After for a capacity failure', async () => {
    const router = binding({ output: '', error: { $typeName: 'modelrouter.inference.v1.ModelError', code: 8, reason: 'MODEL_RATE_LIMIT', message: 'Safe synthetic failure.', retryAfterSeconds: 120 } });
    await expect(classifyEmails(router, 'codex', EMAILS, PROMPT)).rejects.toMatchObject({ kind: 'infrastructure', code: 'codex_rate_limit', retryAfterMs: 120_000 });
  });

  it.each([
    [() => Response.json({ error: { code: 503, status: 'UNAVAILABLE', message: 'Synthetic maintenance.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'MODEL_MAINTENANCE', domain: 'model-router.example' }] } }, { status: 503 }), 'infrastructure', 'codex_unavailable'],
    [() => Response.json({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'Synthetic.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'MODEL_AUTH', domain: 'model-router.example' }] } }, { status: 401 }), 'configuration', 'codex_auth'],
    [() => Response.json({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Synthetic.', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'CALLER_NOT_CONFIGURED', domain: 'model-router.example' }] } }, { status: 403 }), 'configuration', 'codex_not_allowed'],
    [() => new Response('<html>synthetic gateway page</html>', { status: 502 }), 'infrastructure', 'codex_unavailable'],
    [() => { throw new TypeError('synthetic network failure'); }, 'infrastructure', 'codex_unavailable'],
  ] as const)('classifies a Router refusal or transport failure (%#) without per-mail attempts', async (answer, kind, code) => {
    const router = { fetch: vi.fn(() => Promise.resolve().then(answer)) };
    await expect(classifyEmails(router, 'codex', EMAILS, PROMPT)).rejects.toMatchObject({ kind, code });
  });

  it('retains usage when the app rejects missing or foreign message IDs', async () => {
    const router = binding({ output: JSON.stringify({ items: [{ id: 'foreign-id', bucket: 'P3', reason: 'Synthetic' }] }) });
    await expect(classifyEmails(router, 'codex', EMAILS, PROMPT)).rejects.toMatchObject({ code: 'codex_bad_answer', usage: { inputTokens: 150 } });
  });

  it('does not claim subscription token usage when it is unavailable', async () => {
    const router = binding({ usage: { $typeName: 'modelrouter.inference.v1.Usage', available: false, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, billingKind: 'subscription' } });
    expect(await classifyEmails(router, 'codex', EMAILS, PROMPT)).toMatchObject({ inputTokens: 0, outputTokens: 0, costMicros: 0 });
  });

  it.each(['claude', 'codex', 'openai', 'google'] as const)('requires an API cost from common billing metadata under the saved %s choice', async provider => {
    const router = binding({ usage: { $typeName: 'modelrouter.inference.v1.Usage', available: true, inputTokens: 150, outputTokens: 50, cachedInputTokens: 30, cacheWriteTokens: 20, billingKind: 'api' } });
    await expect(classifyEmails(router, provider, EMAILS, PROMPT)).rejects.toMatchObject({ code: `${provider}_bad_answer` });
  });

  it.each(['claude', 'codex'] as const)('accepts subscription usage without an API price under the saved %s choice', async provider => {
    const router = binding({ usage: { $typeName: 'modelrouter.inference.v1.Usage', available: true, inputTokens: 150, outputTokens: 50, cachedInputTokens: 30, cacheWriteTokens: 0, billingKind: 'subscription' } });
    expect(await classifyEmails(router, provider, EMAILS, PROMPT)).toMatchObject({ inputTokens: 150, outputTokens: 50, costMicros: 0 });
  });

  it.each(['claude', 'codex'] as const)('keeps subscription reference value out of API spend under the saved %s choice', async provider => {
    const router = binding({ usage: { $typeName: 'modelrouter.inference.v1.Usage', available: true, inputTokens: 150, outputTokens: 50, cachedInputTokens: 30, cacheWriteTokens: 0, estimatedCostMicrousd: 999, billingKind: 'subscription' } });
    expect(await classifyEmails(router, provider, EMAILS, PROMPT)).toMatchObject({ inputTokens: 150, outputTokens: 50, costMicros: 0 });
  });

  it('refuses a missing binding before sending any input', async () => {
    await expect(classifyEmails(undefined, 'claude', EMAILS, PROMPT)).rejects.toMatchObject({ code: 'claude_not_configured', kind: 'configuration' });
  });
});
