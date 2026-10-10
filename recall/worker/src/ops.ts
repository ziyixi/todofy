/**
 * The named WorkerEntrypoint "Ops" (contracts/ops-v1, ../../docs/design.md §9): status() for the dashboard "home",
 * reached only through its service binding (no public route). It forwards to RecallState, which writes the answer with
 * the wire codec (ops-status.ts). recall has no guard: setGuard always rejects with `invalid_input`, as Fleet's does.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type * as wire from '@ziyixi/proto/ops/v1/ops_wire';
import { RECALL_OBJECT, type Env } from './env.ts';

export class Ops extends WorkerEntrypoint<Env> {
  async status(): Promise<wire.OpsStatus> {
    try {
      return await this.env.RECALL.get(this.env.RECALL.idFromName(RECALL_OBJECT)).opsStatus();
    } catch {
      throw new Error('unavailable');
    }
  }

  setGuard(): never {
    throw new Error('invalid_input');
  }
}
