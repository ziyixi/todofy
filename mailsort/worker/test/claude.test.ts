import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_MODEL, ClaudeBudgetError, ClaudeConfigurationError, ClaudeError, classifyEmails, type ClaudeEmail } from '../src/claude.ts';
import { RESPONSE_MAX_BYTES } from '../src/limits.ts';
import { PERSONAL_RULES, PRIORITY_PROMPT } from '../src/priority-prompt.ts';

const EMAILS = [{
  id: 'synthetic-a', subject: '周末读书活动', sender: 'Community <[address]>',
  received_at: '2026-10-24T18:00:00Z', evaluated_at: '2026-10-24T19:00:00Z', time_zone: 'America/Los_Angeles',
  body: '本周活动已结束；下周安排另行通知。', body_truncated: false,
}, {
  id: 'synthetic-b', subject: '本月生活汇总', sender: 'Account report',
  received_at: '2026-10-24T18:30:00Z', evaluated_at: '2026-10-24T19:00:00Z', time_zone: 'America/Los_Angeles',
  body: '本月账目汇总，供周末核对。', body_truncated: true,
}] as const satisfies readonly ClaudeEmail[];
const ITEMS = [{ id: 'synthetic-a', bucket: 'P4', reason: '活动已结束，保留供日后查询。' }, { id: 'synthetic-b', bucket: 'P3', reason: '本月生活汇总适合周末核对。' }];
const USAGE = { input_tokens: 139_914, output_tokens: 5_476, output_tokens_details: { thinking_tokens: 1_303 } };

function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'message', role: 'assistant', model: CLAUDE_MODEL, stop_reason: 'end_turn', usage: USAGE,
    content: [{ type: 'thinking', thinking: 'synthetic hidden analysis', signature: 'synthetic-signature' }, { type: 'text', text: JSON.stringify({ items: ITEMS }) }],
    ...overrides,
  };
}

function answer(value: unknown = message()): typeof fetch {
  return vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
}

describe('the Mailsort Claude batch request', () => {
  it('sends the existing prompt and all benchmark fields to one fixed Opus medium endpoint', async () => {
    const calls: Request[] = [];
    const fetcher: typeof fetch = (input, init) => {
      calls.push(new Request(input, init));
      return Promise.resolve(Response.json(message()));
    };
    const result = await classifyEmails('synthetic-key', EMAILS, fetcher);
    expect(calls).toHaveLength(1);
    const request = calls[0];
    expect(request?.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request?.method).toBe('POST');
    expect(request?.redirect).toBe('manual');
    expect(request?.headers.get('anthropic-version')).toBe('2026-10-21');
    expect(request?.headers.get('x-api-key')).toBe('synthetic-key');
    const body: unknown = await request?.json();
    expect(body).toEqual({
      model: CLAUDE_MODEL, max_tokens: 16_384, thinking: { type: 'adaptive' },
      system: [{ type: 'text', text: PRIORITY_PROMPT }, { type: 'text', text: PERSONAL_RULES }],
      messages: [{ role: 'user', content: JSON.stringify({ emails: EMAILS }) }],
      output_config: {
        effort: 'medium',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object', required: ['items'], additionalProperties: false,
            properties: {
              items: {
                type: 'array', items: {
                  type: 'object', required: ['id', 'bucket', 'reason'], additionalProperties: false,
                  properties: { id: { type: 'string' }, bucket: { type: 'string', enum: ['P1', 'P2', 'P3', 'P4'] }, reason: { type: 'string' } },
                },
              },
            },
          },
        },
      },
    });
    expect(result).toEqual({ items: ITEMS, model: CLAUDE_MODEL, inputTokens: 139_914, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 5_476, thinkingTokens: 1_303, costMicros: 669_176 });
    expect(result).not.toHaveProperty('thinking');
  });

  it('accepts a reordered result and preserves each original ID', async () => {
    const result = await classifyEmails('synthetic-key', EMAILS, answer(message({ content: [{ type: 'text', text: JSON.stringify({ items: [...ITEMS].reverse() }) }] })));
    expect(result.items.map(item => item.id)).toEqual(['synthetic-b', 'synthetic-a']);
  });

  it('reports an absent thinking breakdown as unknown while charging the inclusive output once', async () => {
    const result = await classifyEmails('synthetic-key', EMAILS, answer(message({ usage: { input_tokens: 10, output_tokens: 5 } })));
    expect(result).toMatchObject({ inputTokens: 10, outputTokens: 5, thinkingTokens: null, costMicros: 140 });
  });

  it('marks only the two stable prompt blocks and keeps changing mail outside the cache prefix', async () => {
    const requests: Record<string, unknown>[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(await new Request(input, init).json<Record<string, unknown>>());
      return Response.json(message());
    };
    const base = 'Synthetic classification instructions.';
    const rules = 'Synthetic owner rules.';
    const options = { basePrompt: base, personalRules: rules, cachePrompt: true };
    await classifyEmails('synthetic-key', EMAILS, fetcher, options);
    await classifyEmails('synthetic-key', EMAILS.map(email => ({ ...email, evaluated_at: '2026-10-24T19:01:00Z', body: `${email.body} New synthetic text.` })), fetcher, options);
    await classifyEmails('synthetic-key', EMAILS, fetcher, { ...options, personalRules: 'Updated synthetic owner rules.' });
    await classifyEmails('synthetic-key', EMAILS, fetcher, { ...options, basePrompt: 'Updated synthetic base instructions.' });

    const cache = { type: 'ephemeral', ttl: '5m' };
    expect(requests[0]?.['system']).toEqual([
      { type: 'text', text: base, cache_control: cache },
      { type: 'text', text: rules, cache_control: cache },
    ]);
    expect(requests[1]?.['system']).toEqual(requests[0]?.['system']);
    expect(requests[1]?.['messages']).not.toEqual(requests[0]?.['messages']);
    expect(requests[2]?.['system']).toEqual([
      { type: 'text', text: base, cache_control: cache },
      { type: 'text', text: 'Updated synthetic owner rules.', cache_control: cache },
    ]);
    expect(requests[3]?.['system']).toEqual([
      { type: 'text', text: 'Updated synthetic base instructions.', cache_control: cache },
      { type: 'text', text: rules, cache_control: cache },
    ]);
    for (const request of requests) {
      expect(request).not.toHaveProperty('cache_control');
      expect(JSON.stringify(request['messages'])).not.toContain('cache_control');
    }
  });

  it('leaves prompt overrides uncached unless the caller explicitly enables caching', async () => {
    const requests: Record<string, unknown>[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(await new Request(input, init).json<Record<string, unknown>>());
      return Response.json(message());
    };
    await classifyEmails('synthetic-key', EMAILS, fetcher, { basePrompt: 'Synthetic base.', personalRules: 'Synthetic rules.' });
    expect(requests[0]?.['system']).toEqual([{ type: 'text', text: 'Synthetic base.' }, { type: 'text', text: 'Synthetic rules.' }]);
  });

  it('allows cleared personal rules without sending an empty API text block', async () => {
    const requests: Record<string, unknown>[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      requests.push(await new Request(input, init).json<Record<string, unknown>>());
      return Response.json(message());
    };
    await classifyEmails('synthetic-key', EMAILS, fetcher, { personalRules: ' \n ', cachePrompt: true });
    expect(requests[0]?.['system']).toEqual([{ type: 'text', text: PRIORITY_PROMPT, cache_control: { type: 'ephemeral', ttl: '5m' } }]);
  });

  it('rejects an empty base prompt before sending a request', async () => {
    const fetcher = answer();
    await expect(classifyEmails('synthetic-key', EMAILS, fetcher, { basePrompt: ' \n ' })).rejects.toMatchObject({ name: 'ClaudeConfigurationError', code: 'claude_bad_prompt' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { emails: [] }, { emails: [EMAILS[0], EMAILS[0]] }, { emails: [{ ...EMAILS[0], id: '' }] },
  ])('rejects an empty or ambiguous input batch without a request: %j', async ({ emails }) => {
    const fetcher = answer();
    await expect(classifyEmails('synthetic-key', emails, fetcher)).rejects.toMatchObject({ code: 'claude_bad_input' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not call Claude without an API key', async () => {
    const fetcher = answer();
    await expect(classifyEmails('  ', EMAILS, fetcher)).rejects.toBeInstanceOf(ClaudeConfigurationError);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('actual Claude cache usage and cost', () => {
  it('counts cache reads and both cache-write TTLs in total input and their own price categories', async () => {
    const usage = {
      input_tokens: 10, cache_creation_input_tokens: 300, cache_read_input_tokens: 400,
      cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
      output_tokens: 5, output_tokens_details: { thinking_tokens: 2 },
    };
    const result = await classifyEmails('synthetic-key', EMAILS, answer(message({ usage })));
    expect(result).toMatchObject({ inputTokens: 710, cacheWriteTokens: 300, cacheReadTokens: 400, outputTokens: 5, thinkingTokens: 2, costMicros: 2_320 });
  });

  it('uses the requested 5m rate when an older response omits the TTL breakdown and thinking usage', async () => {
    const usage = { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 400, output_tokens: 5 };
    const result = await classifyEmails('synthetic-key', EMAILS, answer(message({ usage })));
    expect(result).toMatchObject({ inputTokens: 610, cacheWriteTokens: 200, cacheReadTokens: 400, thinkingTokens: null, costMicros: 1_220 });
  });

  it('rounds fractional microdollar cache reads up once per request', async () => {
    const result = await classifyEmails('synthetic-key', EMAILS, answer(message({ usage: { input_tokens: 0, cache_read_input_tokens: 3, output_tokens: 0 } })));
    expect(result).toMatchObject({ inputTokens: 3, cacheWriteTokens: 0, cacheReadTokens: 3, thinkingTokens: null, costMicros: 1 });
  });

  it('retains billed cached usage when the returned item IDs are invalid', async () => {
    const usage = { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 400, output_tokens: 5 };
    await expect(classifyEmails('synthetic-key', EMAILS, answer(message({ usage, content: [{ type: 'text', text: '{"items":[]}' }] })))).rejects.toMatchObject({
      code: 'claude_bad_items', usage: { inputTokens: 610, cacheWriteTokens: 200, cacheReadTokens: 400, thinkingTokens: null, costMicros: 1_220 },
    });
  });

  it.each([
    { cache_creation_input_tokens: -1 },
    { cache_read_input_tokens: '400' },
    { cache_read_input_tokens: 1.5 },
    { cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 99 } },
    { cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 101, ephemeral_1h_input_tokens: -1 } },
    { cache_creation_input_tokens: 100, cache_creation: 'not a breakdown' },
    { cache_read_input_tokens: Number.MAX_SAFE_INTEGER },
  ])('rejects inconsistent or invalid provider cache counts: %j', async cache => {
    await expect(classifyEmails('synthetic-key', EMAILS, answer(message({ usage: { ...USAGE, ...cache } })))).rejects.toMatchObject({ code: 'claude_bad_usage' });
  });
});

describe('strict Claude result coverage', () => {
  it.each([
    { items: ITEMS.slice(0, 1) },
    { items: [ITEMS[0], ITEMS[0]] },
    { items: [ITEMS[0], { ...ITEMS[1], id: 'unrequested' }] },
    { items: [...ITEMS, { id: 'extra', bucket: 'P1', reason: '额外结果' }] },
    { items: [ITEMS[0], { ...ITEMS[1], bucket: 'none' }] },
    { items: [ITEMS[0], { ...ITEMS[1], reason: '' }] },
    { items: [ITEMS[0], { ...ITEMS[1], reason: 42 }] },
    { items: [ITEMS[0], { ...ITEMS[1], confidence: 0.9 }] },
    { items: ITEMS, reasoning: 'unexpected' },
    { items: [ITEMS[0], null] },
  ])('rejects an invalid batch atomically and retains billed usage: %j', async value => {
    await expect(classifyEmails('synthetic-key', EMAILS, answer(message({ content: [{ type: 'text', text: JSON.stringify(value) }] })))).rejects.toMatchObject({
      code: 'claude_bad_items', usage: { inputTokens: 139_914, outputTokens: 5_476, thinkingTokens: 1_303, costMicros: 669_176 },
    });
  });

  it.each(['max_tokens', 'refusal', 'tool_use', null])('rejects stop_reason=%s even if the JSON is valid', async stop_reason => {
    await expect(classifyEmails('synthetic-key', EMAILS, answer(message({ stop_reason })))).rejects.toMatchObject({ code: 'claude_incomplete', usage: { costMicros: 669_176 } });
  });

  it.each([
    { content: [{ type: 'text', text: 'not JSON' }], code: 'claude_bad_json' },
    { content: [{ type: 'tool_use', id: 'tool', name: 'unexpected' }], code: 'claude_bad_content' },
  ])('rejects malformed output without exposing model text: $code', async ({ content, code }) => {
    const error = await classifyEmails('synthetic-key', EMAILS, answer(message({ content }))).catch((error: unknown) => error);
    expect(error).toMatchObject({ code, message: code, usage: { costMicros: 669_176 } });
    expect(JSON.stringify(error)).not.toContain('not JSON');
  });

  it.each([
    { model: 'other-model' },
    { usage: { ...USAGE, input_tokens: -1 } },
    { usage: { ...USAGE, output_tokens: 1.5 } },
    { usage: { ...USAGE, input_tokens: '139914' } },
    { usage: { ...USAGE, output_tokens_details: { thinking_tokens: 6_000 } } },
    { usage: { ...USAGE, output_tokens_details: {} } },
    { usage: { ...USAGE, input_tokens: Number.MAX_SAFE_INTEGER } },
  ])('rejects an unexpected model or invalid usage: %j', async overrides => {
    await expect(classifyEmails('synthetic-key', EMAILS, answer(message(overrides)))).rejects.toBeInstanceOf(ClaudeError);
  });
});

describe('Claude transport and provider failures', () => {
  it.each([
    [400, { type: 'invalid_request_error', message: 'You have reached your specified workspace API usage limits. Access resumes next month.' }],
    [400, { type: 'invalid_request_error', message: 'You have reached your specified API usage limits.' }],
    [429, { type: 'rate_limit_error', details: { error_code: 'enforced_spend_limit_reached' } }],
  ])('keeps a provider spend stop distinct from a transient error: HTTP %i', async (status, error) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error }, { status }));
    await expect(classifyEmails('synthetic-key', EMAILS, fetcher)).rejects.toBeInstanceOf(ClaudeBudgetError);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])('exposes HTTP %i as a configuration stop', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { message: 'synthetic private provider text' } }, { status }));
    await expect(classifyEmails('synthetic-key', EMAILS, fetcher)).rejects.toMatchObject({ name: 'ClaudeConfigurationError', code: `claude_${String(status)}`, message: `claude_${String(status)}`, status });
  });

  it.each([400, 429, 500, 529, 302])('does not retry or follow redirects for HTTP %i', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { type: 'rate_limit_error', message: 'synthetic private provider text' } }, { status }));
    const error = await classifyEmails('synthetic-key', EMAILS, fetcher).catch((error: unknown) => error);
    expect(error).toMatchObject({ name: 'ClaudeError', code: `claude_http_${String(status)}`, status });
    expect(error).not.toBeInstanceOf(ClaudeBudgetError);
    expect(JSON.stringify(error)).not.toContain('synthetic private provider text');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds the response before parsing it', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'content-length': String(RESPONSE_MAX_BYTES + 1) } });
    await expect(classifyEmails('synthetic-key', EMAILS, vi.fn<typeof fetch>().mockResolvedValue(response))).rejects.toMatchObject({ code: 'claude_response_too_large' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('maps network exceptions to a safe code', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('synthetic-key and private provider content'));
    await expect(classifyEmails('synthetic-key', EMAILS, fetcher)).rejects.toMatchObject({ code: 'claude_network', message: 'claude_network' });
  });

  it('keeps the 120-second timeout active through response-body reading', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    const fetcher: typeof fetch = (_input, init) => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(stream) {
        init?.signal?.addEventListener('abort', () => { stream.error(new Error('synthetic response timeout')); });
      },
    })));
    const result = classifyEmails('synthetic-key', EMAILS, fetcher);
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'claude_timeout' });
    expect(timeout).toHaveBeenCalledWith(120_000);
  });
});
