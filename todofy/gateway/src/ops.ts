/**
 * The ops-v1 surface of Todofy (contracts/ops-v1/README.md): the named entrypoint "Ops" that a
 * dashboard Worker in the same account binds with
 *
 *   [[services]]  binding = "TODOFY"  service = "todofy"  entrypoint = "Ops"
 *
 * It has no HTTP route and no Access policy: only a Worker deployed in this account can create
 * that binding. Each method forwards to one TodofyCore RPC method, which answers `{ok}` or
 * `{error}`; this class turns an error into `new Error(code)` (the message crosses RPC intact).
 * A failed core call (object down, deploy in progress, Python exception) rejects `unavailable`.
 * The core validates every input against the schema's rules; the gateway only refuses what it
 * cannot even pass on (a non-string ID, input that is not JSON, a report over 8 KiB, a task
 * intent over 64 KiB).
 *
 * Its ops-v1 methods are the generated OpsService, CanaryConsumerService and OpsDigestService of
 * proto/ops/v1 (ops_wire.ts, types only): wire JSON in and out, read and written by the core.
 *
 * The same entrypoint carries task-intent-v1 (contracts/task-intent-v1/README.md): another app in
 * the account proposes Todoist tasks with `proposeTasks` and reads the outcome with
 * `taskIntentStatus`; Todofy stays the only Todoist writer. Their signatures come from the generated
 * `TaskIntentService` (proto/todofy/taskintent/v1/task_intent.proto): wire JSON in, wire JSON out. The
 * core reads the input strictly and writes the result with the wire JSON profile (proto/README.md); this
 * class only passes both on, so the gateway bundles none of the generated code (types only).
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { OPS_LIMITS } from '../../../contracts/ops-v1/ops-v1.ts';
import type * as ops from '@ziyixi/proto/ops/v1/ops_wire';
import { TASK_INTENT_LIMITS } from '../../../contracts/task-intent-v1/task-intent-v1.ts';
import type { TaskIntentService } from '@ziyixi/proto/todofy/taskintent/v1/task_intent_pb';
import type { WireObject, WireService } from '@ziyixi/proto/wire-json';
import { coordinator, type Coordinator, type OpsAnswer } from './coordinator.ts';
import type { Env } from './env.ts';

const encoder = new TextEncoder();

function fail(code: ops.ErrorCode): Error {
  return new Error(code);
}

/** JSON text of an RPC argument; anything JSON cannot carry is invalid input. */
function json(value: unknown): string {
  // undefined (or a function) would stringify to undefined, whatever the lib type says.
  if (value === undefined || typeof value === 'function') throw fail('invalid_input');
  try {
    return JSON.stringify(value);
  } catch {
    throw fail('invalid_input'); // a cycle or a BigInt
  }
}

export class Ops
  extends WorkerEntrypoint<Env>
  implements ops.OpsService, ops.CanaryConsumerService, ops.OpsDigestService, WireService<typeof TaskIntentService>
{
  private async call<T>(method: (core: DurableObjectStub<Coordinator>) => Promise<OpsAnswer<T>>): Promise<T> {
    let answer: OpsAnswer<T>;
    try {
      answer = await method(coordinator(this.env));
    } catch {
      throw fail('unavailable');
    }
    if (answer.error !== undefined) throw fail(answer.error);
    return answer.ok;
  }

  async status(): Promise<ops.OpsStatus> {
    return await this.call((core) => core.ops_status());
  }

  async setGuard(input: ops.SetGuardInput): Promise<ops.GuardState> {
    const text = json(input);
    return await this.call((core) => core.ops_set_guard(text));
  }

  async canaryResult(eventId: string): Promise<ops.CanaryResult> {
    if (typeof eventId !== 'string') throw fail('invalid_input');
    return await this.call((core) => core.ops_canary_result(eventId));
  }

  async reportOps(report: ops.OpsReport): Promise<ops.OpsReportReceipt> {
    const text = json(report);
    // Compact JSON is what the core stores; refuse an oversized report before waking the object.
    if (encoder.encode(text).byteLength > OPS_LIMITS.reportMaxBytes) throw fail('invalid_input');
    return await this.call((core) => core.ops_report(text));
  }

  async proposeTasks(intent: WireObject): Promise<WireObject> {
    const text = json(intent);
    // The bound of the contract, on the compact JSON the core parses; refused before waking the object.
    if (encoder.encode(text).byteLength > TASK_INTENT_LIMITS.intentMaxBytes) throw fail('invalid_input');
    return await this.call((core) => core.task_intent_propose(text));
  }

  async taskIntentStatus(ref: WireObject): Promise<WireObject> {
    const text = json(ref);
    if (encoder.encode(text).byteLength > TASK_INTENT_LIMITS.intentMaxBytes) throw fail('invalid_input');
    return await this.call((core) => core.task_intent_status(text));
  }
}
