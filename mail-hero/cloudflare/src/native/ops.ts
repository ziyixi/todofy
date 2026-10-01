/** contracts/ops-v1 (proto/ops/v1/ops.proto): the named entrypoint `Ops` that the dashboard Worker reaches through a
 * service binding (`service = "mail-hero"`, `entrypoint = "Ops"`). No public route leads here: only a Worker deployed
 * in the same Cloudflare account can bind it. Its methods are the generated OpsService and CanaryProducerService of
 * ops_wire.ts (wire JSON in and out); the logic is in ops-core.ts, which reads every argument strictly. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type * as wire from '@ziyixi/proto/ops/v1/ops_wire';
import type { Env } from './types.ts';
import { canaryDelivery, opsCall, opsSetGuard, opsStatus, startCanary } from './ops-core.ts';

export class Ops extends WorkerEntrypoint<Env> implements wire.OpsService, wire.CanaryProducerService {
  status(): Promise<wire.OpsStatus> { return opsCall(() => opsStatus(this.env)); }
  setGuard(input: wire.SetGuardInput): Promise<wire.GuardState> { return opsCall(() => opsSetGuard(this.env, input)); }
  startCanary(input: wire.StartCanaryInput): Promise<wire.StartCanaryResult> { return opsCall(() => startCanary(this.env, input)); }
  canaryDelivery(eventId: string): Promise<wire.CanaryDelivery> { return opsCall(() => canaryDelivery(this.env, eventId)); }
}
