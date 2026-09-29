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
 * cannot even pass on (a non-string ID, input that is not JSON, a report over 8 KiB).
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { OPS_LIMITS } from '../../../contracts/ops-v1/ops-v1.ts';
import type {
  CanaryResult,
  EventId,
  GuardState,
  OpsErrorCode,
  OpsReport,
  OpsReportReceipt,
  SetGuardInput,
  TodofyOps,
  TodofyStatus,
} from '../../../contracts/ops-v1/ops-v1.ts';
import { coordinator, type Coordinator, type OpsAnswer } from './coordinator.ts';
import type { Env } from './env.ts';

const encoder = new TextEncoder();

function fail(code: OpsErrorCode): Error {
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

export class Ops extends WorkerEntrypoint<Env> implements TodofyOps {
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

  async status(): Promise<TodofyStatus> {
    return await this.call((core) => core.ops_status());
  }

  async setGuard(input: SetGuardInput): Promise<GuardState> {
    const text = json(input);
    return await this.call((core) => core.ops_set_guard(text));
  }

  async canaryResult(eventId: EventId): Promise<CanaryResult> {
    if (typeof eventId !== 'string') throw fail('invalid_input');
    return await this.call((core) => core.ops_canary_result(eventId));
  }

  async reportOps(report: OpsReport): Promise<OpsReportReceipt> {
    const text = json(report);
    // Compact JSON is what the core stores; refuse an oversized report before waking the object.
    if (encoder.encode(text).byteLength > OPS_LIMITS.reportMaxBytes) throw fail('invalid_input');
    return await this.call((core) => core.ops_report(text));
  }
}
