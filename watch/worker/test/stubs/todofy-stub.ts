/**
 * Stub of Todofy's gateway entrypoint "Intents" for the workerd suite (test/runtime/harness.ts, `todofy: true`), bound
 * as watch/wrangler.toml binds it (`props.source = "watch"`; like Todofy it refuses any other source with
 * `invalid_input`): proposeTasks and taskIntentStatus, as the generated TaskIntentService declares them. Like Todofy it
 * reads every input strictly with the wire JSON profile and checks it against the contract schema (an invalid one
 * rejects with `invalid_input` and is counted), freezes recorded intents by their bytes (other bytes under the same ID
 * are a conflict), re-queues a failed intent proposed again with the same bytes, and answers schema-valid
 * TaskIntentResults of source watch. With `day` set it also keeps Todofy's daily limit: 10 new intents per source and
 * day, counted by the day it records them (the stub's day is the scenario's, since the Worker's clock is the test's).
 * POST /__scenario changes what it answers; GET /__state shows what arrived.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { validate } from '../../../../contracts/ops-v1/validate.mjs';
import schema from '../../../../contracts/task-intent-v1/task-intent-v1.schema.json';
import { Mode, TaskIntentRefSchema, TaskIntentSchema, type TaskIntentService } from '@ziyixi/proto/todofy/taskintent/v1/task_intent_pb';
import { fromWire, WireJsonError, type WireObject, type WireService } from '@ziyixi/proto/wire-json';

/** A recorded intent's state at Todofy. */
type Held = 'pending' | 'created' | 'failed';

interface Scenario {
  /** accept (record), throw (reject unavailable), paused (record nothing), daily_limit, garbled (an unreadable answer). */
  propose?: 'accept' | 'throw' | 'paused' | 'daily_limit' | 'garbled';
  /**
   * What taskIntentStatus answers for a recorded intent: by default a pending one is created by then (the stub's
   * Todoist is instant); `pending`, `failed` (and the intent stays failed until proposed again) or `throw`.
   */
  status?: 'pending' | 'failed' | 'throw';
  /** Todofy's UTC day: when set, at most 10 new intents are recorded per day value (`daily_limit` past them). */
  day?: string;
}

const SCHEMA = schema as { $defs: Record<string, unknown> };
const DAILY_LIMIT = 10;
let scenario: Scenario = {};
const recorded = new Map<string, { json: string; total: number; intent: WireObject; state: Held; day: string | null }>();
const calls: string[] = [];
const statusCalls: string[] = [];
let invalid = 0;

function result(id: string, state: string, isRecorded: boolean, total: number, error: string | null, retry: number | null): WireObject {
  return {
    version: 'task-intent-v1',
    source: 'watch',
    intent_id: id,
    state,
    recorded: isRecorded,
    tasks_total: total,
    tasks_created: state === 'created' || state === 'duplicate' ? total : 0,
    error_code: error,
    retry_after_seconds: retry,
    updated_at: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
  };
}

function refuse(): Promise<never> {
  invalid++;
  return Promise.reject(new Error('invalid_input'));
}

export class Intents extends WorkerEntrypoint<unknown, { source?: unknown }> implements WireService<typeof TaskIntentService> {
  /** Todofy's Intents: only the binding's own source (todofy/gateway/src/ops.ts). */
  private bound(input: WireObject): boolean {
    return this.ctx.props.source === 'watch' && input['source'] === this.ctx.props.source;
  }

  proposeTasks(input: WireObject): Promise<WireObject> {
    const id = typeof input['intent_id'] === 'string' ? input['intent_id'] : '';
    calls.push(id);
    if (!this.bound(input)) return refuse();
    let total: number;
    try {
      const intent = fromWire(TaskIntentSchema, input, { strict: true }).message;
      if (validate(SCHEMA, 'TaskIntent', input).length > 0) throw new WireJsonError('schema');
      total = intent.items.length + (intent.mode === Mode.SUBTASKS ? 1 : 0);
    } catch (error) {
      if (!(error instanceof WireJsonError)) throw error;
      return refuse();
    }
    if (scenario.propose === 'throw') return Promise.reject(new Error('unavailable'));
    if (scenario.propose === 'garbled') return Promise.resolve({ state: 'pending' });
    const json = JSON.stringify(input);
    const existing = recorded.get(id);
    if (existing !== undefined) {
      // A replay, answered before any other check (as Todofy's record step (1)).
      if (existing.json !== json) return Promise.resolve(result(id, 'rejected', true, existing.total, 'intent_conflict', null));
      if (existing.state === 'created') return Promise.resolve(result(id, 'duplicate', true, existing.total, null, null));
      // A failed intent proposed again with the same bytes re-queues its unfinished tasks.
      existing.state = 'pending';
      return Promise.resolve(result(id, 'pending', true, existing.total, null, 3));
    }
    if (scenario.propose === 'paused') return Promise.resolve(result(id, 'paused', false, 0, 'maintenance', 3600));
    const day = scenario.day ?? null;
    const today = day === null ? 0 : [...recorded.values()].filter((entry) => entry.day === day).length;
    if (scenario.propose === 'daily_limit' || today >= DAILY_LIMIT) return Promise.resolve(result(id, 'rejected', false, 0, 'daily_limit', 7200));
    recorded.set(id, { json, total, intent: input, state: 'pending', day });
    return Promise.resolve(result(id, 'pending', true, total, null, 3));
  }

  taskIntentStatus(input: WireObject): Promise<WireObject> {
    const id = typeof input['intent_id'] === 'string' ? input['intent_id'] : '';
    statusCalls.push(id);
    if (!this.bound(input)) return refuse();
    try {
      fromWire(TaskIntentRefSchema, input, { strict: true });
      if (validate(SCHEMA, 'TaskIntentRef', input).length > 0) throw new WireJsonError('schema');
    } catch (error) {
      if (!(error instanceof WireJsonError)) throw error;
      return refuse();
    }
    if (scenario.status === 'throw') return Promise.reject(new Error('unavailable'));
    const entry = recorded.get(id);
    if (entry === undefined) return Promise.resolve(result(id, 'not_found', false, 0, null, null));
    if (scenario.status === 'failed') entry.state = 'failed';
    else if (scenario.status === undefined && entry.state === 'pending') entry.state = 'created';
    const error = entry.state === 'failed' ? 'todoist_rejected' : null;
    return Promise.resolve(result(id, entry.state, true, entry.total, error, entry.state === 'pending' ? 3 : null));
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__scenario' && request.method === 'POST') {
      scenario = await request.json();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/__state') {
      return Response.json({ invalid, calls: calls.splice(0), statusCalls: statusCalls.splice(0), intents: [...recorded.values()].map((entry) => entry.intent) });
    }
    return new Response('stub', { status: 404 });
  },
};
