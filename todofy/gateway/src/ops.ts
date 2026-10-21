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
 * The core reads every input with the contract's rules (the wire codec); the gateway only refuses what it
 * cannot even pass on (a non-string ID, input that is not JSON).
 *
 * Its ops-v1 methods are the generated OpsService and CanaryConsumerService of proto/ops/v1 (ops_wire.ts, types
 * only): wire JSON in and out, read and written by the core. Todofy implements no OpsDigestService since 2026-10-21:
 * Home creates the daily reminder in Tasks itself.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type * as ops from '@ziyixi/proto/ops/v1/ops_wire';
import { coordinator, type Coordinator, type OpsAnswer } from './coordinator.ts';
import type { Env } from './env.ts';

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

export class Ops extends WorkerEntrypoint<Env> implements ops.OpsService, ops.CanaryConsumerService {
  /** One TodofyCore RPC call: its value, `new Error(code)` for its error, `unavailable` when the call itself fails. */
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
}
