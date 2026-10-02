/**
 * Stub of Todofy's gateway entrypoint "Intents" for the workerd suite (test/runtime/harness.ts, `todofy: true`), bound
 * as watch/wrangler.toml binds it (`props.source = "watch"`; like Todofy it refuses any other source with
 * `invalid_input`): proposeTasks and taskIntentStatus, as the generated TaskIntentService declares them. Like Todofy it reads every input strictly with the wire
 * JSON profile and checks it against the contract schema (an invalid one rejects with `invalid_input` and is counted),
 * freezes recorded intents by their bytes (other bytes under the same ID are a conflict), and answers schema-valid
 * TaskIntentResults of source watch. POST /__scenario changes what it answers; GET /__state shows what arrived.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { validate } from '../../../../contracts/ops-v1/validate.mjs';
import schema from '../../../../contracts/task-intent-v1/task-intent-v1.schema.json';
import { Mode, TaskIntentSchema, type TaskIntentService } from '@ziyixi/proto/todofy/taskintent/v1/task_intent_pb';
import { fromWire, WireJsonError, type WireObject, type WireService } from '@ziyixi/proto/wire-json';

interface Scenario {
  /** accept (record), throw (reject unavailable), paused (record nothing), daily_limit, garbled (an unreadable answer). */
  propose?: 'accept' | 'throw' | 'paused' | 'daily_limit' | 'garbled';
}

const SCHEMA = schema as { $defs: Record<string, unknown> };
let scenario: Scenario = {};
const recorded = new Map<string, { json: string; total: number; intent: WireObject }>();
const calls: string[] = [];
let invalid = 0;

function result(id: string, state: string, isRecorded: boolean, total: number, error: string | null, retry: number | null): WireObject {
  return {
    version: 'task-intent-v1',
    source: 'watch',
    intent_id: id,
    state,
    recorded: isRecorded,
    tasks_total: total,
    tasks_created: 0,
    error_code: error,
    retry_after_seconds: retry,
    updated_at: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z'),
  };
}

export class Intents extends WorkerEntrypoint<unknown, { source?: unknown }> implements Pick<WireService<typeof TaskIntentService>, 'proposeTasks'> {
  proposeTasks(input: WireObject): Promise<WireObject> {
    const id = typeof input['intent_id'] === 'string' ? input['intent_id'] : '';
    calls.push(id);
    // Todofy's Intents: only the binding's own source (todofy/gateway/src/ops.ts).
    if (this.ctx.props.source !== 'watch' || input['source'] !== this.ctx.props.source) {
      invalid++;
      return Promise.reject(new Error('invalid_input'));
    }
    let total: number;
    try {
      const intent = fromWire(TaskIntentSchema, input, { strict: true }).message;
      if (validate(SCHEMA, 'TaskIntent', input).length > 0) throw new WireJsonError('schema');
      total = intent.items.length + (intent.mode === Mode.SUBTASKS ? 1 : 0);
    } catch (error) {
      if (!(error instanceof WireJsonError)) throw error;
      invalid++;
      return Promise.reject(new Error('invalid_input'));
    }
    if (scenario.propose === 'throw') return Promise.reject(new Error('unavailable'));
    if (scenario.propose === 'garbled') return Promise.resolve({ state: 'pending' });
    const json = JSON.stringify(input);
    const existing = recorded.get(id);
    if (existing !== undefined) {
      return Promise.resolve(existing.json === json ? result(id, 'duplicate', true, existing.total, null, null) : result(id, 'rejected', true, existing.total, 'intent_conflict', null));
    }
    if (scenario.propose === 'paused') return Promise.resolve(result(id, 'paused', false, 0, 'maintenance', 3600));
    if (scenario.propose === 'daily_limit') return Promise.resolve(result(id, 'rejected', false, 0, 'daily_limit', 7200));
    recorded.set(id, { json, total, intent: input });
    return Promise.resolve(result(id, 'pending', true, total, null, 3));
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
      return Response.json({ invalid, calls: calls.splice(0), intents: [...recorded.values()].map((entry) => entry.intent) });
    }
    return new Response('stub', { status: 404 });
  },
};
