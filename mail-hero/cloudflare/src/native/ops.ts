/** contracts/ops-v1: the named entrypoint `Ops` that the dashboard Worker reaches through a service
 * binding (`service = "mail-hero"`, `entrypoint = "Ops"`). No public route leads here: only a Worker
 * deployed in the same Cloudflare account can bind it. The logic is in ops-core.ts. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { CanaryDelivery, EventId, GuardState, MailHeroOps, MailHeroStatus, SetGuardInput, StartCanaryInput,
  StartCanaryResult } from '../../../../contracts/ops-v1/ops-v1.ts';
import type { Env } from './types.ts';
import { canaryDelivery, opsCall, opsSetGuard, opsStatus, startCanary } from './ops-core.ts';

export class Ops extends WorkerEntrypoint<Env> implements MailHeroOps {
  status(): Promise<MailHeroStatus> { return opsCall(() => opsStatus(this.env)); }
  setGuard(input: SetGuardInput): Promise<GuardState> { return opsCall(() => opsSetGuard(this.env, input)); }
  startCanary(input: StartCanaryInput): Promise<StartCanaryResult> { return opsCall(() => startCanary(this.env, input)); }
  canaryDelivery(eventId: EventId): Promise<CanaryDelivery> { return opsCall(() => canaryDelivery(this.env, eventId)); }
}
