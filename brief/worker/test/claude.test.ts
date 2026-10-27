/** Brief's business ledger over the common Router, using only synthetic messages. */
import { describe, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { GenerateRequestSchema, ListModelsResponseSchema, type GenerateRequest } from '@ziyixi/proto/modelrouter/inference/v1/inference_pb';
import { attemptsOf, callModel, callsStopped, monthSpend, rejectedState, resumeCalls, settleOpenCalls, unreadAnswer, type CallContext, type ModelRequest } from '../src/claude.ts';
import { OPUS_MODEL } from '../src/limits.ts';
import { pickRequest } from '../src/prompts.ts';
import { writeSettings } from '../src/settings.ts';
import { Store } from '../src/store.ts';
import { jsonAnswer, modelError, modelResponse, type FakeMessage } from './fakes/claude.ts';
import { memorySql } from './fakes/sql.ts';

const NOW = Date.parse('2026-10-12T10:31:00Z');
function context(message: FakeMessage = jsonAnswer({ research: [], world: [] }), overrides: Partial<CallContext> = {}) {
  const store = new Store(memorySql()); store.migrate();
  const calls: GenerateRequest[] = [];
  const connection = { configured: true, revision: 'synthetic-connection', inputRate: 5, outputRate: 25 };
  const binding = { async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.endsWith('/models')) return Response.json(toWire(ListModelsResponseSchema, create(ListModelsResponseSchema, { models: [{ id: OPUS_MODEL, configured: connection.configured, reservationInputMicrousdPerToken: connection.inputRate, reservationOutputMicrousdPerToken: connection.outputRate }] })));
    const input = fromWire(GenerateRequestSchema, await request.json()).message;
    calls.push(input);
    return modelResponse(input, message);
  } };
  const ctx: CallContext = { store, env: { MODEL_ROUTER: binding, BUILD_SHA: 'test' }, now: () => NOW, transact: fn => fn(), timeLeft: () => 900_000, budgetUsd: 40, mode: 'live', ...overrides };
  return { ctx, store, calls, connection };
}
const PICK = pickRequest('2026-10-12', [], [], {});
const opus = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({ step: 'pick', issue: '2026-10-12', model: OPUS_MODEL, params: PICK.params, estimatedInputTokens: 15_000, ...overrides });

describe('Brief Router ledger', () => {
  it('reserves catalog worst-case rates and settles the returned actual cost', async () => {
    const { ctx, store, calls } = context(jsonAnswer({ research: [], world: [] }, 'synthetic-served', { inputTokens: 15_000, outputTokens: 6000, estimatedCostMicrousd: 321_000 }));
    expect(await callModel(ctx, opus())).toMatchObject({ kind: 'answer', served: 'synthetic-served' });
    expect(store.one(`SELECT state, input, output, stop, cost, reserved FROM calls`)).toEqual({ state: 'done', input: 15_000, output: 6000, stop: 'end_turn', cost: 0.321, reserved: 0.875 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: OPUS_MODEL, effort: 'medium', maxOutputTokens: 32_000, allowFallback: true });
    expect(JSON.parse(calls[0]?.outputSchemaJson ?? '{}')).toMatchObject({ type: 'object' });
    expect(calls[0]?.timeoutMs).toBe(780_000);
  });

  it('preserves contributing models, cache subsets and a completed answer for crash recovery', async () => {
    const { ctx, store } = context({ ...jsonAnswer({ research: [], world: [] }), contributingModels: ['synthetic-primary', 'synthetic-fallback'], usage: { inputTokens: 150, outputTokens: 50, cachedInputTokens: 30, cacheWriteTokens: 20, estimatedCostMicrousd: 1506 } });
    const outcome = await callModel(ctx, opus());
    expect(outcome).toMatchObject({ kind: 'answer', writers: ['synthetic-primary', 'synthetic-fallback'] });
    const row = unreadAnswer(store, '2026-10-12', 'pick', 0);
    expect(row).toMatchObject({ input: 150, output: 50, cache_write: 20, cache_read: 30, cost: 0.001506 });
    expect(JSON.parse(row?.writers ?? '[]')).toEqual(['synthetic-primary', 'synthetic-fallback']);
  });

  it.each([['refused', 'refusal'], ['output_limit', 'invalid']])('retains actual costs and attempt semantics for %s', async (finishReason, kind) => {
    const { ctx, store } = context({ finishReason });
    expect(await callModel(ctx, opus())).toMatchObject({ kind });
    expect(store.one(`SELECT state, cost FROM calls`)).toEqual({ state: 'done', cost: 0.02 });
    expect(attemptsOf(store, '2026-10-12', 'pick')).toBe(1);
  });

  it('keeps a reservation and observed partial counts after an interrupted model', async () => {
    const { ctx, store } = context({ ...modelError('MODEL_UNAVAILABLE', 14), usage: { available: false, inputTokens: 150, cachedInputTokens: 30, cacheWriteTokens: 20 } });
    expect(await callModel(ctx, opus())).toMatchObject({ kind: 'failed', code: 'MODEL_UNAVAILABLE' });
    expect(store.one(`SELECT state, cost, input, cache_write, cache_read FROM calls`)).toEqual({ state: 'failed', cost: 0.875, input: 150, cache_write: 20, cache_read: 30 });
    expect(attemptsOf(store, '2026-10-12', 'pick')).toBe(1);
  });

  it('releases an explicitly unstarted transient result and honors retry delay', async () => {
    const { ctx, store } = context({ ...modelError('MODEL_RATE_LIMIT', 8), error: { code: 8, reason: 'MODEL_RATE_LIMIT', retryAfterSeconds: 17 } });
    expect(await callModel(ctx, opus())).toEqual({ kind: 'transient', code: 'MODEL_RATE_LIMIT', retryAfterMs: 17_000 });
    expect(store.one(`SELECT state, cost FROM calls`)).toEqual({ state: 'released', cost: 0 });
    expect(attemptsOf(store, '2026-10-12', 'pick')).toBe(0);
  });

  it('stops rejected connections until the build changes or owner resumes', async () => {
    const { ctx, store, calls } = context(modelError('MODEL_AUTH', 7));
    expect(await callModel(ctx, opus())).toEqual({ kind: 'rejected', status: 7, errorType: 'MODEL_AUTH' });
    expect(rejectedState(store)).toMatchObject({ build: 'test' });
    expect(await callModel(ctx, opus())).toEqual({ kind: 'blocked', reason: 'rejected' });
    expect(calls).toHaveLength(1);
    expect(callsStopped(store, { ...ctx.env, BUILD_SHA: 'test-2' })).toBe(false);
    await callModel(ctx, opus()); resumeCalls(store);
    expect(callsStopped(store, ctx.env)).toBe(false);
  });

  it('preserves mode, pause, missing connection and budget gates', async () => {
    const off = context(undefined, { mode: 'off' }); expect(await callModel(off.ctx, opus())).toEqual({ kind: 'blocked', reason: 'mode_off' }); expect(off.calls).toEqual([]);
    const paused = context(); writeSettings(paused.store, { paused: true }, NOW); expect(await callModel(paused.ctx, opus())).toEqual({ kind: 'blocked', reason: 'paused' });
    const missing = context(); missing.connection.configured = false; expect(await callModel(missing.ctx, opus())).toEqual({ kind: 'blocked', reason: 'not_configured' });
    const budget = context(undefined, { budgetUsd: 0.5 }); expect(await callModel(budget.ctx, opus())).toEqual({ kind: 'blocked', reason: 'budget' }); expect(budget.calls).toEqual([]);
    expect(monthSpend(budget.store, '2026-10')).toEqual({ spent: 0, reserved: 0 });
  });

  it('keeps the reservation when transport completion and cost are unknown', async () => {
    const { ctx, store } = context();
    if (!ctx.env.MODEL_ROUTER) throw new Error('missing synthetic binding');
    ctx.env.MODEL_ROUTER.fetch = request => {
      if (new URL(request.url).pathname.endsWith('/models')) return Promise.resolve(Response.json(toWire(ListModelsResponseSchema, create(ListModelsResponseSchema, { models: [{ id: OPUS_MODEL, configured: true, reservationInputMicrousdPerToken: 5, reservationOutputMicrousdPerToken: 25 }] }))));
      return Promise.reject(new Error('synthetic private transport failure'));
    };
    expect(await callModel(ctx, opus())).toMatchObject({ kind: 'failed', code: 'model_connection_interrupted' });
    expect(store.one(`SELECT state, cost FROM calls`)).toEqual({ state: 'failed', cost: 0.875 });
  });

  it('settles deploy-killed and crashed calls without erasing historical costs', () => {
    const { store } = context();
    for (const [build, reserved] of [['old', 0.1], ['test', 0.2]] as const) store.insert('calls', { issue: '2026-10-12', step: 'pick', attempt: 1, build, model: OPUS_MODEL, state: 'open', reserved, day: '2026-10-12', month: '2026-10', started_ms: NOW });
    expect(settleOpenCalls(store, 'test', NOW + 1)).toEqual({ killed: 1, crashed: 1 });
    expect(attemptsOf(store, '2026-10-12', 'pick')).toBe(1);
    expect(monthSpend(store, '2026-10').spent).toBeCloseTo(0.3);
  });
});
