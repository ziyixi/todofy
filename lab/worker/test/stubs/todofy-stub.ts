/**
 * Stub of Todofy's gateway entrypoint "Ops" for the workerd suite (test/runtime/harness.ts): only the two
 * task-intent-v1 methods. Every input is checked against the contract schema (an invalid one rejects with
 * `invalid_input` and is counted), recorded intents are frozen by hash, and every answer is a schema-valid
 * TaskIntentResult. A scenario (POST /__scenario) changes the behaviour; GET /__state shows what arrived.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { validate } from '../../../../contracts/ops-v1/validate.mjs';
import schema from '../../../../contracts/task-intent-v1/task-intent-v1.schema.json';
import type { TaskIntent, TaskIntentRef, TaskIntentResult } from '../../../../contracts/task-intent-v1/task-intent-v1.ts';

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
  intent: TaskIntent;
}

const SCHEMA = schema as { $defs: Record<string, unknown> };
let scenario: Scenario = {};
const intents = new Map<string, Stored>();
const calls: { method: string; intent_id: string }[] = [];
let invalid = 0;

function now(): string {
  return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

function result(intentId: string, state: TaskIntentResult['state'], recorded: boolean, stored: Stored | undefined, error: TaskIntentResult['error_code'] = null): TaskIntentResult {
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

export class Ops extends WorkerEntrypoint {
  proposeTasks(intent: TaskIntent): Promise<TaskIntentResult> {
    calls.push({ method: 'proposeTasks', intent_id: (intent as { intent_id?: string } | null)?.intent_id ?? '' });
    if (validate(SCHEMA, 'TaskIntent', intent).length > 0) {
      invalid++;
      return Promise.reject(new Error('invalid_input'));
    }
    if (scenario.propose === 'throw') return Promise.reject(new Error('unavailable'));
    const json = JSON.stringify(intent);
    const existing = intents.get(intent.intent_id);
    if (existing !== undefined) {
      if (existing.json !== json) return Promise.resolve(result(intent.intent_id, 'rejected', true, existing, 'intent_conflict'));
      if (existing.created >= existing.total) return Promise.resolve(result(intent.intent_id, 'duplicate', true, existing));
      if (existing.failed && scenario.propose === 'held') return Promise.resolve(result(intent.intent_id, 'paused', true, existing, 'todoist_paused'));
      existing.failed = false; // re-queued
      return Promise.resolve(result(intent.intent_id, 'pending', true, existing));
    }
    if (scenario.propose === 'paused') return Promise.resolve(result(intent.intent_id, 'paused', false, undefined, 'todoist_paused'));
    if (scenario.propose === 'daily_limit') return Promise.resolve(result(intent.intent_id, 'rejected', false, undefined, 'daily_limit'));
    const stored: Stored = { json, total: intent.items.length + (intent.mode === 'subtasks' ? 1 : 0), created: 0, failed: false, intent };
    intents.set(intent.intent_id, stored);
    return Promise.resolve(result(intent.intent_id, 'pending', true, stored));
  }

  taskIntentStatus(ref: TaskIntentRef): Promise<TaskIntentResult> {
    calls.push({ method: 'taskIntentStatus', intent_id: (ref as { intent_id?: string } | null)?.intent_id ?? '' });
    if (validate(SCHEMA, 'TaskIntentRef', ref).length > 0) {
      invalid++;
      return Promise.reject(new Error('invalid_input'));
    }
    if (scenario.status === 'throw') return Promise.reject(new Error('unavailable'));
    const stored = intents.get(ref.intent_id);
    if (stored === undefined) return Promise.resolve(result(ref.intent_id, 'not_found', false, undefined));
    if (scenario.status === 'failed' || stored.failed) {
      stored.failed = true;
      return Promise.resolve(result(ref.intent_id, 'failed', true, stored, 'todoist_rejected'));
    }
    stored.created = Math.min(stored.total, stored.created + 6);
    return Promise.resolve(result(ref.intent_id, stored.created >= stored.total ? 'created' : 'pending', true, stored));
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
      return Response.json({
        invalid,
        calls: calls.splice(0),
        intents: [...intents.entries()].map(([id, s]) => ({ id, total: s.total, created: s.created, intent: s.intent })),
      });
    }
    return new Response('stub', { status: 404 });
  },
};
