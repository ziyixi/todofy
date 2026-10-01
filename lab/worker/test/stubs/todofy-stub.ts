/**
 * Stub of Todofy's gateway entrypoint "Ops" for the workerd suite (test/runtime/harness.ts): only the two
 * task-intent-v1 methods, as the generated TaskIntentService declares them. Like Todofy, it reads every input
 * strictly with the wire JSON profile and checks it against the contract schema (an invalid one rejects with
 * `invalid_input` and is counted); recorded intents are frozen by their bytes, and every answer is a
 * schema-valid TaskIntentResult in wire JSON. A scenario (POST /__scenario) changes the behaviour; GET
 * /__state shows what arrived.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { validate } from '../../../../contracts/ops-v1/validate.mjs';
import schema from '../../../../contracts/task-intent-v1/task-intent-v1.schema.json';
import type { DescMessage, MessageShape } from '@ziyixi/proto/protobuf';
import { Mode, TaskIntentRefSchema, TaskIntentSchema, type TaskIntentService } from '@ziyixi/proto/todofy/taskintent/v1/task_intent_pb';
import { fromWire, WireJsonError, type WireObject, type WireService } from '@ziyixi/proto/wire-json';

/** A TaskIntentResult as the stub writes it (wire JSON). */
interface Result {
  readonly version: 'task-intent-v1';
  readonly source: 'lab';
  readonly intent_id: string;
  readonly state: 'pending' | 'created' | 'duplicate' | 'paused' | 'failed' | 'rejected' | 'not_found';
  readonly recorded: boolean;
  readonly tasks_total: number;
  readonly tasks_created: number;
  readonly error_code: 'todoist_paused' | 'todoist_rejected' | 'intent_conflict' | 'daily_limit' | null;
  readonly retry_after_seconds: number | null;
  readonly updated_at: string;
}

interface Scenario {
  /**
   * accept (record, then create 6 tasks per status call), paused (record nothing), throw (reject unavailable),
   * daily_limit, held (Todofy's answer while a pause holds: a recorded failed intent is answered paused and
   * re-queued nothing).
   */
  propose?: 'accept' | 'paused' | 'throw' | 'daily_limit' | 'held';
  /** normal, throw (reject unavailable), or failed (Todoist refused a task: the intent fails). */
  status?: 'normal' | 'throw' | 'failed';
}

interface Stored {
  json: string;
  total: number;
  created: number;
  failed: boolean;
  intent: WireObject;
}

const SCHEMA = schema as { $defs: Record<string, unknown> };
let scenario: Scenario = {};
const intents = new Map<string, Stored>();
const calls: { method: string; intent_id: string }[] = [];
let invalid = 0;

function now(): string {
  return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/** The input read the way Todofy reads it (strict wire read, then the schema's value rules), or null. */
function read<Desc extends DescMessage>(name: 'TaskIntent' | 'TaskIntentRef', desc: Desc, value: unknown): MessageShape<Desc> | null {
  try {
    const message = fromWire(desc, value, { strict: true }).message;
    return validate(SCHEMA, name, value).length === 0 ? message : null;
  } catch (error) {
    if (error instanceof WireJsonError) return null;
    throw error;
  }
}

function result(intentId: string, state: Result['state'], recorded: boolean, stored: Stored | undefined, error: Result['error_code'] = null): Result {
  const pending = state === 'pending' || (state === 'paused' && recorded);
  return {
    version: 'task-intent-v1',
    source: 'lab',
    intent_id: intentId,
    state,
    recorded,
    tasks_total: recorded ? (stored?.total ?? 0) : 0,
    tasks_created: recorded ? (stored?.created ?? 0) : 0,
    error_code: error,
    retry_after_seconds: pending ? 3 : null,
    updated_at: now(),
  };
}

export class Ops extends WorkerEntrypoint implements WireService<typeof TaskIntentService> {
  proposeTasks(input: WireObject): Promise<WireObject> {
    calls.push({ method: 'proposeTasks', intent_id: idOf(input) });
    const intent = read('TaskIntent', TaskIntentSchema, input);
    if (intent === null) {
      invalid++;
      return Promise.reject(new Error('invalid_input'));
    }
    if (scenario.propose === 'throw') return Promise.reject(new Error('unavailable'));
    const id = intent.intentId;
    const json = JSON.stringify(input);
    const existing = intents.get(id);
    if (existing !== undefined) {
      if (existing.json !== json) return answer(result(id, 'rejected', true, existing, 'intent_conflict'));
      if (existing.created >= existing.total) return answer(result(id, 'duplicate', true, existing));
      if (existing.failed && scenario.propose === 'held') return answer(result(id, 'paused', true, existing, 'todoist_paused'));
      existing.failed = false; // re-queued
      return answer(result(id, 'pending', true, existing));
    }
    if (scenario.propose === 'paused') return answer(result(id, 'paused', false, undefined, 'todoist_paused'));
    if (scenario.propose === 'daily_limit') return answer(result(id, 'rejected', false, undefined, 'daily_limit'));
    const stored: Stored = { json, total: intent.items.length + (intent.mode === Mode.SUBTASKS ? 1 : 0), created: 0, failed: false, intent: input };
    intents.set(id, stored);
    return answer(result(id, 'pending', true, stored));
  }

  taskIntentStatus(input: WireObject): Promise<WireObject> {
    calls.push({ method: 'taskIntentStatus', intent_id: idOf(input) });
    const ref = read('TaskIntentRef', TaskIntentRefSchema, input);
    if (ref === null) {
      invalid++;
      return Promise.reject(new Error('invalid_input'));
    }
    if (scenario.status === 'throw') return Promise.reject(new Error('unavailable'));
    const id = ref.intentId;
    const stored = intents.get(id);
    if (stored === undefined) return answer(result(id, 'not_found', false, undefined));
    if (scenario.status === 'failed' || stored.failed) {
      stored.failed = true;
      return answer(result(id, 'failed', true, stored, 'todoist_rejected'));
    }
    stored.created = Math.min(stored.total, stored.created + 6);
    return answer(result(id, stored.created >= stored.total ? 'created' : 'pending', true, stored));
  }
}

function idOf(input: unknown): string {
  const id = (input as { intent_id?: unknown } | null)?.intent_id;
  return typeof id === 'string' ? id : '';
}

function answer(value: Result): Promise<WireObject> {
  return Promise.resolve({ ...value });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__scenario' && request.method === 'POST') {
      scenario = await request.json();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/__state') {
      return Response.json({
        invalid,
        calls: calls.splice(0),
        intents: [...intents.entries()].map(([id, s]) => ({ id, total: s.total, created: s.created, intent: s.intent })),
      });
    }
    return new Response('stub', { status: 404 });
  },
};
