/**
 * Stub of Tasks' create-only entrypoint "TaskInbox" for the workerd suite (test/runtime/harness.ts, `tasks: true`), bound
 * as watch/wrangler.toml binds it (`props.source = "watch"`; like Tasks it refuses any other source with
 * `invalid_input`): createInboxTask, as the generated TaskInboxService declares it. Like Tasks (tasks/worker/src/inbox.ts)
 * it reads every input strictly with the wire JSON profile (an invalid one rejects with `invalid_input` and is counted),
 * answers a repeated request_id with its first answer (`replayed`), refuses one reused for other input, and refuses the
 * 21st task of a day with `daily_limit` (the stub's day is the scenario's, since the Worker's clock is the test's).
 * POST /__scenario changes what it answers; GET /__state shows what arrived.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { CreateInboxTaskRequestSchema } from '@ziyixi/proto/tasks/inbox/v1/task_inbox_pb';
import type { CreateInboxTaskRequest, CreateInboxTaskResponse, TaskInboxService } from '@ziyixi/proto/tasks/inbox/v1/task_inbox_wire';
import { fromWire } from '@ziyixi/proto/wire-json';

interface Scenario {
  /**
   * create (the default), throw (reject unavailable, nothing created), lose (create, then reject unavailable: a lost
   * answer) or daily_limit (nothing created).
   */
  create?: 'create' | 'throw' | 'lose' | 'daily_limit';
  /** Tasks' UTC day: at most 20 tasks are created per day value (`daily_limit` past them). */
  day?: string;
}

const DAILY_LIMIT = 20;
let scenario: Scenario = {};
const created = new Map<string, { json: string; answer: CreateInboxTaskResponse; request: CreateInboxTaskRequest; day: string | null }>();
const calls: string[] = [];
let invalid = 0;

function refuse(): Promise<never> {
  invalid++;
  return Promise.reject(new Error('invalid_input'));
}

export class TaskInbox extends WorkerEntrypoint<unknown, { source?: unknown }> implements TaskInboxService {
  createInboxTask(input: CreateInboxTaskRequest): Promise<CreateInboxTaskResponse> {
    calls.push(typeof input.request_id === 'string' ? input.request_id : '');
    if (this.ctx.props.source !== 'watch') return refuse();
    try {
      fromWire(CreateInboxTaskRequestSchema, input, { strict: true });
    } catch {
      return refuse();
    }
    const json = JSON.stringify(input);
    const existing = created.get(input.request_id);
    if (existing !== undefined) return existing.json === json ? Promise.resolve({ ...existing.answer, replayed: true }) : refuse();
    if (scenario.create === 'throw') return Promise.reject(new Error('unavailable'));
    const day = scenario.day ?? null;
    const today = day === null ? 0 : [...created.values()].filter((entry) => entry.day === day).length;
    if (scenario.create === 'daily_limit' || today >= DAILY_LIMIT) return Promise.reject(new Error('daily_limit'));
    const answer: CreateInboxTaskResponse = {
      task_id: crypto.randomUUID(),
      subtask_ids: (input.subtasks ?? []).map(() => crypto.randomUUID()),
      replayed: false,
    };
    created.set(input.request_id, { json, answer, request: input, day });
    if (scenario.create === 'lose') return Promise.reject(new Error('unavailable'));
    return Promise.resolve(answer);
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
      return Response.json({ invalid, calls: calls.splice(0), tasks: [...created.values()].map((entry) => entry.request) });
    }
    return new Response('stub', { status: 404 });
  },
};
