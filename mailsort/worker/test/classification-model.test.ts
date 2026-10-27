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

  it.each(['MODEL_SPEND_LIMIT', 'MODEL_AUTH', 'MODEL_NOT_CONFIGURED', 'MODEL_QUOTA', 'MODEL_INVALID_ANSWER', 'MODEL_REFUSED', 'MODEL_OUTPUT_LIMIT'])('maps common reason %s without interpreting vendor payloads', async reason => {
    const code = reason === 'MODEL_AUTH' ? 7 : reason === 'MODEL_NOT_CONFIGURED' || reason === 'MODEL_REFUSED' ? 9 : reason === 'MODEL_INVALID_ANSWER' ? 13 : 8;
    const router = binding({ output: '', error: { $typeName: 'modelrouter.inference.v1.ModelError', code, reason, message: 'Safe synthetic failure.', retryAfterSeconds: 0 } });
    const error = await classifyEmails(router, 'claude', EMAILS, PROMPT).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ClassificationError);
    expect(error).toMatchObject({ attempted: reason !== 'MODEL_NOT_CONFIGURED', spendLimited: reason === 'MODEL_SPEND_LIMIT', configuration: reason === 'MODEL_AUTH' || reason === 'MODEL_NOT_CONFIGURED', usage: { inputTokens: 150, costMicros: 1506 } });
  });

  it('retains usage when the app rejects missing or foreign message IDs', async () => {
    const router = binding({ output: JSON.stringify({ items: [{ id: 'foreign-id', bucket: 'P3', reason: 'Synthetic' }] }) });
    await expect(classifyEmails(router, 'codex', EMAILS, PROMPT)).rejects.toMatchObject({ code: 'codex_bad_answer', usage: { inputTokens: 150 } });
  });

  it('does not claim subscription token usage when it is unavailable', async () => {
    const router = binding({ usage: { $typeName: 'modelrouter.inference.v1.Usage', available: false, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, billingKind: 'subscription' } });
    expect(await classifyEmails(router, 'codex', EMAILS, PROMPT)).toMatchObject({ inputTokens: 0, outputTokens: 0, costMicros: 0 });
  });

  it.each(['claude', 'codex'] as const)('requires an API cost from common billing metadata under the saved %s choice', async provider => {
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
    await expect(classifyEmails(undefined, 'claude', EMAILS, PROMPT)).rejects.toMatchObject({ code: 'claude_not_configured', attempted: false });
  });
});
