/**
 * The named WorkerEntrypoint "Ops" (contracts/ops-v1, docs/design.md §10): status() and setGuard() for the
 * dashboard "home", reached only through its service binding (no public route). Both forward to LabState;
 * a method rejects only with `new Error(code)`, code in invalid_input / unavailable.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { GuardState, LabOps, LabStatus, SetGuardInput } from '../../../contracts/ops-v1/ops-v1.ts';
import type { Env } from './env.ts';
import { LAB_OBJECT, type LabState } from './state.ts';

export class Ops extends WorkerEntrypoint<Env> implements LabOps {
  private lab(): DurableObjectStub<LabState> {
    return this.env.LAB.get(this.env.LAB.idFromName(LAB_OBJECT));
  }

  async status(): Promise<LabStatus> {
    try {
      return await this.lab().opsStatus();
    } catch {
      throw new Error('unavailable');
    }
  }

  async setGuard(input: SetGuardInput): Promise<GuardState> {
    let result: { ok: GuardState } | { error: 'invalid_input' };
    try {
      result = await this.lab().opsSetGuard(input);
    } catch {
      throw new Error('unavailable');
    }
    if ('error' in result) throw new Error(result.error);
    return result.ok;
  }
}
