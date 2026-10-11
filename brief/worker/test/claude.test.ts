/**
 * The model calls (design §7, §13, §17) over the fake Claude API: the real SDK with an injected fetch and a synthetic
 * key (no real key, no network). The answer joined across a fallback block; refusals; every 4xx class; transient
 * errors; a mid-stream error, the deadline and a stall; reservations at fallback prices and their release; costs from
 * usage with fallback iterations; a deploy-killed attempt not counted.
 */
import { describe, expect, it } from 'vitest';
import { attemptsOf, callModel, callsStopped, monthSpend, rejectedState, resumeCalls, settleOpenCalls, unreadAnswer, type CallContext, type ModelRequest } from '../src/claude.ts';
import { costOfUsage, reservationOf } from '../src/prices.ts';
import { pickRequest } from '../src/prompts.ts';
import { writeSettings } from '../src/settings.ts';
import { Store } from '../src/store.ts';
import { apiError, fakeClaudeFetch, jsonAnswer, sseResponse, type FakeMessage } from './fakes/claude.ts';
import { memorySql } from './fakes/sql.ts';

const NOW = Date.parse('2026-10-12T10:31:00Z');

function context(respond: Parameters<typeof fakeClaudeFetch>[0], overrides: Partial<CallContext> = {}): { ctx: CallContext; store: Store; calls: ReturnType<typeof fakeClaudeFetch>['calls'] } {
  const store = new Store(memorySql());
  store.migrate();
  const fake = fakeClaudeFetch(respond);
  const ctx: CallContext = {
    store,
    env: { ANTHROPIC_API_KEY: 'sk-ant-synthetic-test-key', BUILD_SHA: 'test' },
    fetch: fake.fetch,
    now: () => NOW,
    transact: (fn) => fn(),
    timeLeft: () => 15 * 60_000,
    budgetUsd: 40,
    mode: 'live',
    ...overrides,
  };
  return { ctx, store, calls: fake.calls };
}

const PICK = pickRequest('2026-10-12', [], [], {});
const opus = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({ step: 'pick', issue: '2026-10-12', model: 'claude-opus-5-5', params: PICK.params, estimatedInputTokens: 15_000, ...overrides });

describe('a model call', () => {
  it('streams an answer, reads its JSON and replaces the reservation by the cost from usage', async () => {
    const { ctx, store, calls } = context(() => sseResponse(jsonAnswer({ research: [], world: [] }, 'claude-opus-5-5', { input_tokens: 15_000, output_tokens: 6_000 })));
    const outcome = await callModel(ctx, opus());
    expect(outcome).toMatchObject({ kind: 'answer', json: { research: [], world: [] }, served: 'claude-opus-5-5' });
    const row = store.one<{ state: string; cost: number; reserved: number; input: number; output: number; request_id: string; stop: string }>(`SELECT * FROM calls`);
    expect(row).toMatchObject({ state: 'done', input: 15_000, output: 6_000, request_id: 'req_synthetic', stop: 'end_turn' });
    expect(row?.cost).toBeCloseTo((15_000 * 4 + 6_000 * 20) / 1e6, 8);
    expect(row?.reserved).toBeCloseTo(reservationOf('claude-opus-5-5', 15_000, 32_000), 8);
    // The request: Opus with the server-side fallbacks, adaptive thinking omitted, an explicit effort, structured output.
    const body = calls[0]?.body ?? {};
    expect(body['model']).toBe('claude-opus-5-5');
    expect(body['fallbacks']).toBe('default');
    expect(body['stream']).toBe(true);
    expect(body['thinking']).toBeUndefined();
    expect(body['temperature']).toBeUndefined();
    expect(body['output_config']).toMatchObject({ effort: 'medium', format: { type: 'json_schema' } });
    expect(calls[0]?.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(calls[0]?.headers['x-api-key']).toBe('sk-ant-synthetic-test-key');
  });

  it('joins the text across a fallback block during the stream and prices each iteration at its model', async () => {
    const answer = JSON.stringify({ research: [{ id: 'r1', reason: '理由' }], world: [] });
    const cut = Math.floor(answer.length / 2);
    const message: FakeMessage = {
      model: 'claude-opus-5-5',
      blocks: [{ type: 'thinking' }, { type: 'text', text: answer.slice(0, cut) }, { type: 'fallback', from: 'claude-opus-5-5', to: 'claude-opus-5' }, { type: 'text', text: answer.slice(cut) }],
      usage: {
        input_tokens: 2_000,
        output_tokens: 900,
        iterations: [
          { type: 'message', model: null, input_tokens: 2_000, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 2_100, output_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        ],
      },
    };
    const { ctx, store } = context(() => sseResponse(message));
    const outcome = await callModel(ctx, opus());
    expect(outcome.kind).toBe('answer');
    if (outcome.kind !== 'answer') return;
    expect(outcome.json).toEqual(JSON.parse(answer));
    expect(outcome.served).toBe('claude-opus-5');
    expect(outcome.writers).toEqual(['claude-opus-5-5', 'claude-opus-5']);
    const cost = store.one<{ cost: number }>(`SELECT cost FROM calls`)?.cost ?? 0;
    expect(cost).toBeCloseTo((2_000 * 4 + 300 * 20) / 1e6 + (2_100 * 5 + 900 * 25) / 1e6, 8);
  });

  it('reports a refusal of the whole chain with its category', async () => {
    const { ctx } = context(() => sseResponse({ blocks: [], stop: 'refusal', category: 'reasoning_extraction' }));
    expect(await callModel(ctx, opus())).toMatchObject({ kind: 'refusal', category: 'reasoning_extraction' });
  });

  it('a refusal during the output discards it', async () => {
    const { ctx } = context(() => sseResponse({ blocks: [{ type: 'text', text: '{"research": [' }], stop: 'refusal', category: 'cyber' }));
    expect((await callModel(ctx, opus())).kind).toBe('refusal');
  });

  it('a truncated or non-JSON answer is invalid and uses its attempt', async () => {
    const truncated = context(() => sseResponse({ blocks: [{ type: 'text', text: '{"research": [' }], stop: 'max_tokens' }));
    expect(await callModel(truncated.ctx, opus())).toMatchObject({ kind: 'invalid', code: 'max_tokens' });
    expect(attemptsOf(truncated.store, '2026-10-12', 'pick')).toBe(1);
    const prose = context(() => sseResponse({ blocks: [{ type: 'text', text: 'not json' }] }));
    expect(await callModel(prose.ctx, opus())).toMatchObject({ kind: 'invalid', code: 'not_json' });
    // Never kept for a step to read again: the next try is a new call, not the same bad text.
    expect(attemptsOf(prose.store, '2026-10-12', 'pick')).toBe(1);
    expect(unreadAnswer(prose.store, '2026-10-12', 'pick', 0)).toBeNull();
  });

  it('makes no call while the owner paused the brief or the deployment is off (the emergency stops)', async () => {
    const paused = context(() => sseResponse(jsonAnswer({})));
    writeSettings(paused.store, { paused: true }, NOW);
    expect(await callModel(paused.ctx, opus())).toEqual({ kind: 'blocked', reason: 'paused' });
    writeSettings(paused.store, { paused: false }, NOW);
    expect((await callModel(paused.ctx, opus())).kind).toBe('answer');
    expect(paused.calls).toHaveLength(1);
    const off = context(() => sseResponse(jsonAnswer({})), { mode: 'off' });
    expect(await callModel(off.ctx, opus())).toEqual({ kind: 'blocked', reason: 'mode_off' });
    expect(off.calls).toHaveLength(0);
    expect(off.store.count(`SELECT count(*) AS n FROM calls`)).toBe(0);
  });

  it('a mid-stream overloaded_error fails the attempt and keeps its reservation', async () => {
    const { ctx, store } = context(() => sseResponse({ blocks: [{ type: 'thinking' }, { type: 'text', text: '{"a":' }], errorAfterBlocks: 2 }));
    expect(await callModel(ctx, opus())).toMatchObject({ kind: 'failed', code: 'stream_overloaded_error' });
    const row = store.one<{ state: string; cost: number; reserved: number }>(`SELECT * FROM calls`);
    expect(row?.state).toBe('failed');
    expect(row?.cost).toBe(row?.reserved);
  });

  it('the deadline and a stall abort the stream and fail the attempt', async () => {
    const stalled = (signal: AbortSignal | undefined) => sseResponse({ blocks: [{ type: 'thinking' }], stallAfterBlocks: 1 }, signal);
    const deadline = context(() => stalled);
    expect(await callModel(deadline.ctx, opus({ deadlineMs: 1000 }))).toMatchObject({ kind: 'failed', code: 'deadline' });
    const stall = context(() => stalled, { stallMs: 50 });
    expect(await callModel(stall.ctx, opus())).toMatchObject({ kind: 'failed', code: 'stall' });
  });

  it('408, 409, 429, 529 and 5xx before the stream are transient and cost nothing', async () => {
    for (const [status, type] of [[408, 'timeout_error'], [409, 'conflict_error'], [429, 'rate_limit_error'], [529, 'overloaded_error'], [500, 'api_error'], [503, 'api_error']] as const) {
      const { ctx, store } = context(() => apiError(status, type));
      const outcome = await callModel(ctx, opus());
      expect(outcome).toMatchObject({ kind: 'transient', code: `http_${String(status)}` });
      expect(store.one<{ state: string; cost: number }>(`SELECT state, cost FROM calls`)).toEqual({ state: 'released', cost: 0 });
      expect(attemptsOf(store, '2026-10-12', 'pick')).toBe(0);
      expect(rejectedState(store)).toBeNull();
    }
  });

  it('any other 4xx stops every call until the key changes, a new build deploys or the owner resumes', async () => {
    for (const [status, type] of [[400, 'invalid_request_error'], [401, 'authentication_error'], [402, 'billing_error'], [403, 'permission_error'], [404, 'not_found_error'], [413, 'request_too_large']] as const) {
      const { ctx, store, calls } = context(() => apiError(status, type));
      expect(await callModel(ctx, opus())).toEqual({ kind: 'rejected', status, errorType: type });
      expect(rejectedState(store)).toMatchObject({ status, type, build: 'test' });
      expect(JSON.stringify(rejectedState(store))).not.toContain('sk-ant');
      expect(attemptsOf(store, '2026-10-12', 'pick')).toBe(0);
      expect(await callModel(ctx, opus())).toEqual({ kind: 'blocked', reason: 'rejected' });
      expect(calls).toHaveLength(1);
    }
    const { ctx, store } = context(() => apiError(402, 'billing_error'));
    await callModel(ctx, opus());
    expect(await callsStopped(store, { ANTHROPIC_API_KEY: 'sk-ant-synthetic-test-key', BUILD_SHA: 'test' })).toBe(true);
    expect(await callsStopped(store, { ANTHROPIC_API_KEY: 'sk-ant-another-synthetic-key', BUILD_SHA: 'test' })).toBe(false);
    await callModel(ctx, opus());
    expect(await callsStopped(store, { ANTHROPIC_API_KEY: 'sk-ant-synthetic-test-key', BUILD_SHA: 'test-2' })).toBe(false);
    await callModel(ctx, opus());
    resumeCalls(store);
    expect(await callsStopped(store, ctx.env)).toBe(false);
  });

  it('no key is not configured; a reservation past the month budget is blocked, with the ones in flight', async () => {
    const none = context(() => sseResponse(jsonAnswer({})), { env: { BUILD_SHA: 'test' } });
    expect(await callModel(none.ctx, opus())).toEqual({ kind: 'blocked', reason: 'not_configured' });
    const { ctx, store, calls } = context(() => sseResponse(jsonAnswer({})), { budgetUsd: 5 });
    // A 64K write reserves about $1.8 at the fallbacks' prices; spend and an open reservation leave less.
    store.insert('calls', { issue: '2026-10-11', step: 'write', attempt: 1, build: 'test', model: 'claude-opus-5-5', state: 'done', reserved: 1.8, cost: 2.5, day: '2026-10-11', month: '2026-10', started_ms: NOW - 86_400_000 });
    store.insert('calls', { issue: '2026-10-12', step: 'gate', attempt: 1, build: 'test', model: 'claude-haiku-5-5', state: 'open', reserved: 1.2, day: '2026-10-12', month: '2026-10', started_ms: NOW });
    expect(monthSpend(store, '2026-10')).toEqual({ spent: 2.5, reserved: 1.2 });
    expect(await callModel(ctx, opus({ params: { ...PICK.params, max_tokens: 64_000 }, estimatedInputTokens: 45_000 }))).toEqual({ kind: 'blocked', reason: 'budget' });
    expect(calls).toHaveLength(0);
  });

  it('a call left open by an older build was killed by a deploy (no attempt); by this build, it crashed', () => {
    const store = new Store(memorySql());
    store.migrate();
    store.insert('calls', { issue: '2026-10-12', step: 'write', attempt: 1, build: 'aaaaaaa', model: 'claude-opus-5-5', state: 'open', reserved: 1.85, day: '2026-10-12', month: '2026-10', started_ms: NOW });
    store.insert('calls', { issue: '2026-10-12', step: 'write', attempt: 1, build: 'bbbbbbb', model: 'claude-opus-5-5', state: 'open', reserved: 1.85, day: '2026-10-12', month: '2026-10', started_ms: NOW });
    expect(settleOpenCalls(store, 'bbbbbbb', NOW)).toEqual({ killed: 1, crashed: 1 });
    expect(attemptsOf(store, '2026-10-12', 'write')).toBe(1);
    // Both keep their reservation as their cost.
    expect(monthSpend(store, '2026-10').spent).toBeCloseTo(3.7, 8);
  });
});

describe('cost accounting', () => {
  it('reads cache tokens and the Haiku long-context card', () => {
    expect(costOfUsage({ input_tokens: 1_000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2_000, output_tokens: 500 }, 'claude-haiku-5-5', 'claude-haiku-5-5').cost).toBeCloseTo((1_000 * 0.1 + 10_000 * 0.01 + 2_000 * 0.125 + 500 * 0.5) / 1e6, 10);
    expect(costOfUsage({ input_tokens: 150_000, output_tokens: 100 }, 'claude-haiku-5-5', 'claude-haiku-5-5').cost).toBeCloseTo((150_000 * 0.5 + 100 * 2.5) / 1e6, 10);
    expect(reservationOf('claude-opus-5-5', 45_000, 64_000)).toBeCloseTo(1.825, 6);
  });
});
