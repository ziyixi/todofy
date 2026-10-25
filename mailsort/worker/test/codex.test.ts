/** Synthetic subscription gateway requests through the generated inference client. */
import { describe, expect, it, vi } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { RunInferenceResponseSchema, type RunInferenceResponse } from '@ziyixi/proto/codex/inference/v1/inference_pb';
import { toWire } from '@ziyixi/proto/wire-json';
import { classifyWithCodex } from '../src/codex.ts';
import type { ClassificationEmail } from '../src/classification-result.ts';
import { RESPONSE_MAX_BYTES } from '../src/limits.ts';

const ENV = {
  CODEX_ENDPOINT_URL: 'https://codex.synthetic.example/api/codex/v1/inference:run',
  CODEX_ENDPOINT_TOKEN: 'synthetic-endpoint-token',
  CODEX_ACCESS_CLIENT_ID: 'synthetic-access-id',
  CODEX_ACCESS_CLIENT_SECRET: 'synthetic-access-secret',
};
const PROMPT = { basePrompt: 'Synthetic saved base instructions.', personalRules: '合成个人规则：生活汇总 P3。' };
const EMAILS = [
  { id: 'synthetic-a', subject: '合成活动预告', sender: 'Sender <[address]>', received_at: '2026-10-01T00:00:00Z', evaluated_at: '2026-10-01T01:00:00Z', time_zone: 'America/Los_Angeles', body: '周末活动信息。', body_truncated: false },
  { id: 'synthetic-b', subject: '合成生活汇总', sender: 'Synthetic report', received_at: '2026-10-01T00:30:00Z', evaluated_at: '2026-10-01T01:00:00Z', time_zone: 'America/Los_Angeles', body: '本月信息供周末阅读。', body_truncated: true },
] as const satisfies readonly ClassificationEmail[];
const ITEMS = [{ id: 'synthetic-a', bucket: 'P2', reason: '合成活动需要在几天内查看。' }, { id: 'synthetic-b', bucket: 'P3', reason: '合成汇总适合周末查看。' }];

type ResponseFields = Partial<Omit<RunInferenceResponse, '$typeName' | '$unknown'>>;

function response(overrides: ResponseFields = {}): Response {
  return Response.json(toWire(RunInferenceResponseSchema, create(RunInferenceResponseSchema, {
    model: 'gpt-6.1-sol', effort: 'medium', outputJson: JSON.stringify({ items: ITEMS }), inputTokens: 1200, outputTokens: 120, ...overrides,
  })));
}
const answer = (overrides: ResponseFields = {}): typeof fetch => vi.fn<typeof fetch>().mockResolvedValue(response(overrides));

describe('the Mailsort Codex inference client', () => {
  it('sends saved prompt text and masked mail in one typed request to the configured endpoint', async () => {
    const calls: Request[] = [];
    const fetcher: typeof fetch = (input, init) => {
      calls.push(new Request(input, init));
      return Promise.resolve(response());
    };
    const result = await classifyWithCodex(ENV, EMAILS, fetcher, PROMPT);
    expect(calls).toHaveLength(1);
    const request = calls[0];
    expect(request?.url).toBe(ENV.CODEX_ENDPOINT_URL);
    expect(request?.method).toBe('POST');
    expect(request?.redirect).toBe('manual');
    expect(request?.headers.get('authorization')).toBe('Bearer synthetic-endpoint-token');
    expect(request?.headers.get('CF-Access-Client-Id')).toBe('synthetic-access-id');
    expect(request?.headers.get('CF-Access-Client-Secret')).toBe('synthetic-access-secret');
    const body = await request?.json<Record<string, string>>();
    expect(body?.['instructions']).toBe(`${PROMPT.basePrompt}\n\n${PROMPT.personalRules}`);
    expect(JSON.parse(body?.['input_json'] ?? '{}')).toEqual({ emails: EMAILS });
    const schema: unknown = JSON.parse(body?.['output_schema_json'] ?? '{}');
    expect(schema).toMatchObject({
      required: ['items'], additionalProperties: false,
      properties: { items: { items: { required: ['id', 'bucket', 'reason'], additionalProperties: false, properties: { bucket: { enum: ['P1', 'P2', 'P3', 'P4'] } } } } },
    });
    expect(JSON.stringify(body)).not.toContain(ENV.CODEX_ENDPOINT_TOKEN);
    expect(result).toEqual({ model: 'gpt-6.1-sol', items: ITEMS, inputTokens: 1200, outputTokens: 120 });
    expect(result).not.toHaveProperty('costMicros');
  });

  it('uses the next prompt snapshot, permits cleared rules and preserves reordered message IDs', async () => {
    const bodies: Record<string, string>[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      bodies.push(await new Request(input, init).json<Record<string, string>>());
      return response({ outputJson: JSON.stringify({ items: [...ITEMS].reverse() }) });
    };
    await classifyWithCodex(ENV, EMAILS, fetcher, PROMPT);
    const result = await classifyWithCodex(ENV, EMAILS, fetcher, { basePrompt: 'Updated synthetic base.', personalRules: ' \n ' });
    expect(bodies.map(body => body['instructions'])).toEqual([`${PROMPT.basePrompt}\n\n${PROMPT.personalRules}`, 'Updated synthetic base.']);
    expect(result.items.map(item => item.id)).toEqual(['synthetic-b', 'synthetic-a']);
  });

  it('rejects missing or non-HTTPS configuration and ambiguous input before making a request', async () => {
    const fetcher = answer();
    await expect(classifyWithCodex({ ...ENV, CODEX_ENDPOINT_TOKEN: '' }, EMAILS, fetcher, PROMPT)).rejects.toMatchObject({ name: 'CodexConfigurationError', code: 'codex_not_configured' });
    await expect(classifyWithCodex({ ...ENV, CODEX_ENDPOINT_URL: 'http://codex.synthetic.example/run' }, EMAILS, fetcher, PROMPT)).rejects.toMatchObject({ code: 'codex_not_configured' });
    await expect(classifyWithCodex(ENV, [EMAILS[0], EMAILS[0]], fetcher, PROMPT)).rejects.toMatchObject({ code: 'codex_bad_input' });
    await expect(classifyWithCodex(ENV, EMAILS, fetcher, { ...PROMPT, basePrompt: ' ' })).rejects.toMatchObject({ code: 'codex_bad_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON, incomplete or duplicated IDs and unexpected result fields atomically', async () => {
    await expect(classifyWithCodex(ENV, EMAILS, answer({ outputJson: 'synthetic malformed private output' }), PROMPT)).rejects.toMatchObject({ code: 'codex_bad_json', message: 'codex_bad_json' });
    for (const items of [ITEMS.slice(0, 1), [ITEMS[0], ITEMS[0]], [ITEMS[0], { ...ITEMS[1], id: 'unrequested' }], [ITEMS[0], { ...ITEMS[1], bucket: 'P5' }], [ITEMS[0], { ...ITEMS[1], confidence: 0.8 }]]) {
      await expect(classifyWithCodex(ENV, EMAILS, answer({ outputJson: JSON.stringify({ items }) }), PROMPT)).rejects.toMatchObject({ code: 'codex_bad_items', message: 'codex_bad_items' });
    }
  });

  it('rejects an unexpected model, effort or invalid typed usage instead of accepting the result', async () => {
    for (const fields of [{ model: 'different-model' }, { effort: 'high' }]) {
      await expect(classifyWithCodex(ENV, EMAILS, answer(fields), PROMPT)).rejects.toMatchObject({ code: 'codex_bad_model' });
    }
    await expect(classifyWithCodex(ENV, EMAILS, answer({ inputTokens: -1 }), PROMPT)).rejects.toMatchObject({ code: 'codex_bad_usage' });
    const malformedWire = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ model: 'gpt-6.1-sol', effort: 'medium', input_tokens: '1200', output_json: JSON.stringify({ items: ITEMS }) }));
    await expect(classifyWithCodex(ENV, EMAILS, malformedWire, PROMPT)).rejects.toMatchObject({ code: 'codex_bad_answer' });
  });

  it('keeps subscription quota and auth failures explicit and hides unknown gateway error text', async () => {
    await expect(classifyWithCodex(ENV, EMAILS, answer({ errorCode: 'codex_quota', outputJson: '' }), PROMPT)).rejects.toMatchObject({ code: 'codex_quota' });
    await expect(classifyWithCodex(ENV, EMAILS, answer({ errorCode: 'codex_auth', outputJson: '' }), PROMPT)).rejects.toMatchObject({ name: 'CodexConfigurationError', code: 'codex_auth' });
    const error: unknown = await classifyWithCodex(ENV, EMAILS, answer({ errorCode: 'synthetic-private-provider-detail', outputJson: '' }), PROMPT).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'codex_unavailable', message: 'codex_unavailable' });
    expect(JSON.stringify(error)).not.toContain('synthetic-private-provider-detail');
  });

  it('does not retry or follow redirects and exposes only safe HTTP or network errors', async () => {
    for (const [status, code] of [[302, 'codex_auth'], [429, 'codex_quota'], [503, 'codex_http_503']] as const) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('synthetic private gateway response', { status }));
      const error: unknown = await classifyWithCodex(ENV, EMAILS, fetcher, PROMPT).catch((error: unknown) => error);
      expect(error).toMatchObject({ code, message: code });
      expect(JSON.stringify(error)).not.toContain('synthetic private gateway response');
      expect(fetcher).toHaveBeenCalledOnce();
    }
    await expect(classifyWithCodex(ENV, EMAILS, vi.fn<typeof fetch>().mockRejectedValue(new Error('synthetic private network error')), PROMPT)).rejects.toMatchObject({ code: 'codex_network', message: 'codex_network' });
  });

  it('bounds the response before parsing or exposing its body', async () => {
    const cancel = vi.fn();
    const oversized = new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'content-length': String(RESPONSE_MAX_BYTES + 1) } });
    await expect(classifyWithCodex(ENV, EMAILS, vi.fn<typeof fetch>().mockResolvedValue(oversized), PROMPT)).rejects.toMatchObject({ code: 'codex_response_too_large' });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
