/**
 * ops-v1's rules for the dashboard's tests, from the IDL (proto/ops/v1/ops.proto) and the wire codec: a value's errors
 * as a producer of the contract writes it (a strict read: nothing unknown, every rule), and each app's entrypoint
 * methods (the generated services it implements). Shared by the unit tests and the workerd harness (whose stub apps
 * expose exactly those methods).
 */
import type { DescMessage } from '@ziyixi/proto/protobuf';
import { WebsiteSyncService } from '@ziyixi/proto/website/sync/v1/sync_pb';
import * as ops from '@ziyixi/proto/ops/v1/ops_pb';
import { fromWire, fromWireArguments, WireJsonError } from '@ziyixi/proto/wire-json';
import type { OpsApp } from '../src/api-types.ts';

/** The contract's messages by name (the names of contracts/ops-v1/fixtures/). */
const MESSAGES = {
  OpsStatus: ops.OpsStatusSchema,
  GuardState: ops.GuardStateSchema,
  SetGuardInput: ops.SetGuardInputSchema,
  StartCanaryInput: ops.StartCanaryInputSchema,
  StartCanaryResult: ops.StartCanaryResultSchema,
  CanaryDelivery: ops.CanaryDeliverySchema,
  CanaryResult: ops.CanaryResultSchema,
  OpsReport: ops.OpsReportSchema,
  OpsReportItem: ops.OpsReportItemSchema,
  OpsReportReceipt: ops.OpsReportReceiptSchema,
} satisfies Record<string, DescMessage>;

/** A message of ops-v1 by name, or the event ID a canary lookup takes. */
export type ContractName = keyof typeof MESSAGES | 'EventId';

/** What ops-v1 refuses in `value` as a `name`: empty when it is valid. */
export function contractErrors(name: ContractName, value: unknown): string[] {
  try {
    if (name === 'EventId') fromWireArguments(ops.CanaryProducerService.method.canaryDelivery, [value]);
    else fromWire(MESSAGES[name], value, { strict: true });
    return [];
  } catch (error) {
    if (error instanceof WireJsonError) return [error.message];
    throw error;
  }
}

/** The generated services each app's Ops entrypoint implements. */
const SERVICES = {
  'mail-hero': [ops.OpsService, ops.CanaryProducerService],
  todofy: [ops.OpsService, ops.CanaryConsumerService, ops.OpsDigestService],
  lab: [ops.OpsService],
  watch: [ops.OpsService],
  fleet: [ops.OpsService],
  newsletter: [ops.OpsService],
  'notion-publish': [ops.OpsService, WebsiteSyncService],
} as const;

/** The methods of `app`'s Ops entrypoint, sorted: the dashboard calls only these, the stubs expose exactly these. */
export function declaredMethods(app: OpsApp): string[] {
  return SERVICES[app].flatMap((service) => Object.keys(service.method)).sort();
}
