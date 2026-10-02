/**
 * The named WorkerEntrypoint "Ops" (contracts/ops-v1, ../../docs/design.md §7): status() and setGuard() for the
 * dashboard "home", reached only through its service binding (no public route); its methods are the generated
 * OpsService of proto/ops/v1 (ops_wire.ts). Both forward to WatchState, which reads the input strictly and writes every
 * answer with the wire codec (ops-status.ts); a method rejects only with `new Error(code)`, code in invalid_input /
 * unavailable.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type * as wire from '@ziyixi/proto/ops/v1/ops_wire';
import { WATCH_OBJECT, type Env } from './env.ts';
import type { WatchState } from './state.ts';

export class Ops extends WorkerEntrypoint<Env> implements wire.OpsService {
  private watch(): DurableObjectStub<WatchState> {
    return this.env.WATCH.get(this.env.WATCH.idFromName(WATCH_OBJECT));
  }

  async status(): Promise<wire.OpsStatus> {
    try {
      return await this.watch().opsStatus();
    } catch {
      throw new Error('unavailable');
    }
  }

  async setGuard(input: wire.SetGuardInput): Promise<wire.GuardState> {
    let result: { ok: wire.GuardState } | { error: 'invalid_input' };
    try {
      result = await this.watch().opsSetGuard(input);
    } catch {
      throw new Error('unavailable');
    }
    if ('error' in result) throw new Error(result.error);
    return result.ok;
  }
}
