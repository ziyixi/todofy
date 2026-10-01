/**
 * The only code that calls the apps (docs/design.md §5.1): one wrapper per method of the generated ops-v1 services
 * (proto/ops/v1/ops.proto: OpsService on every app, CanaryProducerService on Mail Hero, CanaryConsumerService and
 * OpsDigestService on Todofy), each with a timeout, the contract's error codes and the wire codec on both sides: what
 * the dashboard sends is checked with the contract's rules first, every answer is read with them. Results are values,
 * never exceptions.
 */
import type { DescMessage, DescMethod } from '@ziyixi/proto/protobuf';
import {
  CanaryConsumerService,
  CanaryDeliverySchema,
  CanaryProducerService,
  CanaryResultSchema,
  ErrorCode,
  ErrorCodeSchema,
  file_ops_v1_ops,
  GuardLevel,
  GuardLevelSchema,
  GuardStateSchema,
  OpsDigestService,
  OpsReportItemSchema,
  OpsReportReceiptSchema,
  OpsReportSchema,
  OpsService,
  OpsStatusSchema,
  StartCanaryResultSchema,
} from '@ziyixi/proto/ops/v1/ops_pb';
import type * as ops from '@ziyixi/proto/ops/v1/ops_wire';
import { fieldRules, formatMatches, fromWire, fromWireArguments, toWire, toWireArguments, wireEnum, WireJsonError, type WireOf } from '@ziyixi/proto/wire-json';
import type { AppErrorCode, OpsApp } from './api-types.ts';
import type { Env } from './env.ts';

export const OPS_TIMEOUT_MS = 10_000;
/** An answer larger than this (as JSON) is `invalid_output`; the contract's bounds keep real ones far smaller. */
export const OPS_MAX_JSON_CHARS = 32_768;

// ---- the contract's values, read from the IDL ------------------------------------------------------

/** Every ops-v1 app, in the contract's order (OpsStatus.app's allowed list). */
export const OPS_APPS = fieldRules(OpsStatusSchema.field.app).allowed as readonly OpsApp[];
/** The guard's levels by wire name. */
export const GUARD_LEVELS: readonly ops.GuardLevel[] = wireEnum(GuardLevelSchema, GuardLevel).names;
/** The codes an Ops method rejects with (`new Error(code)`). */
export const OPS_ERROR_CODES: readonly ops.ErrorCode[] = wireEnum(ErrorCodeSchema, ErrorCode).names;
/** At most this many items in an OpsReport, and metrics per item. */
export const REPORT_MAX_ITEMS = fieldRules(OpsReportSchema.field.items).maxItems;
export const METRICS_MAX_KEYS = fieldRules(OpsReportItemSchema.field.metrics).maxItems;
/** Whether a name is an ops-v1 `Code` (a signal code, a counter or metric name): the IDL's format, the one definition. */
export function isOpsCode(value: string): boolean {
  return formatMatches(file_ops_v1_ops, 'Code', value);
}
/** Whether a report item's source is an ops-v1 `Source`. */
export function isOpsSource(value: string): boolean {
  return formatMatches(file_ops_v1_ops, 'Source', value);
}

export type OpsCall<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: AppErrorCode };

const TIMEOUT = Symbol('timeout');

/** The binding is absent from this deployment (a local config without it). */
class MissingBinding extends Error {}

/** Runs one RPC call with a timeout and maps every outcome to a value (§5.1). */
export async function callOps<T>(
  invoke: () => PromiseLike<unknown>,
  guard: Conformer<T>,
  timeoutMs: number = OPS_TIMEOUT_MS,
): Promise<OpsCall<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<typeof TIMEOUT>((resolve) => {
      timer = setTimeout(() => {
        resolve(TIMEOUT);
      }, timeoutMs);
    });
    const value = await Promise.race([Promise.resolve().then(invoke), timeout]);
    if (value === TIMEOUT) return { ok: false, code: 'timeout' };
    let size: number;
    try {
      size = JSON.stringify(value).length;
    } catch {
      return { ok: false, code: 'invalid_output' };
    }
    const conformed = size > OPS_MAX_JSON_CHARS ? null : guard(value);
    return conformed === null ? { ok: false, code: 'invalid_output' } : { ok: true, value: conformed };
  } catch (error) {
    if (error instanceof MissingBinding) return { ok: false, code: 'not_configured' };
    const message = error instanceof Error ? error.message : '';
    return { ok: false, code: (OPS_ERROR_CODES as readonly string[]).includes(message) ? (message as ops.ErrorCode) : 'unavailable' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---- reading answers ---------------------------------------------------------------------------------
//
// Every answer is read with the contract's rules (the wire codec, a lenient read: the dashboard is a consumer), so a
// buggy release cannot put free text, an address or an extra field into this object's storage or onto the page. The
// consumer rules of the contract (README "Versioning") hold because an app may ship an additive change before this
// Worker is redeployed:
//   - unknown fields are ignored: the reader skips them and the kept value (`toWire` of what was read) has none;
//   - new codes of an open list (`reason`, `waiting_code`) and any `error_code` are kept as they are, if they are
//     codes; the UI shows unknown codes generically;
//   - a new value of an ops-v1 enum (a state, a severity, a health, a level) is refused as invalid_output: the
//     dashboard's flows branch on those, so it does not guess. The IDL says so ((common.wire.v1.closed) on each), and
//     the codec refuses it, as it refuses null for a REQUIRED enum or message ((common.wire.v1.field).non_null).

/** The answer as the contract allows this consumer to keep it (wire JSON, in field order), or null. */
export function conform<D extends DescMessage>(schema: D, value: unknown): WireOf<D> | null {
  try {
    return toWire(schema, fromWire(schema, value).message, { lenient: true });
  } catch (error) {
    if (error instanceof WireJsonError) return null;
    throw error;
  }
}

/** A guard for callOps: the conformed value, or null. */
export type Conformer<T> = (value: unknown) => T | null;

const conformer =
  <D extends DescMessage>(schema: D): Conformer<WireOf<D>> =>
  (value) =>
    conform(schema, value);

export const asGuardState: Conformer<ops.GuardState> = conformer(GuardStateSchema);
export const asStartCanaryResult: Conformer<ops.StartCanaryResult> = conformer(StartCanaryResultSchema);
export const asCanaryDelivery: Conformer<ops.CanaryDelivery> = conformer(CanaryDeliverySchema);
export const asCanaryResult: Conformer<ops.CanaryResult> = conformer(CanaryResultSchema);
export const asReceipt: Conformer<ops.OpsReportReceipt> = conformer(OpsReportReceiptSchema);

/** An OpsStatus of `app` (the contract allows every app). */
export function asStatus(app: OpsApp): Conformer<ops.OpsStatus> {
  return (value) => {
    const status = conform(OpsStatusSchema, value);
    return status !== null && status.app === app ? status : null;
  };
}

// ---- sending inputs ------------------------------------------------------------------------------------

/**
 * The arguments for `method` from what the dashboard built, after a strict read with the contract's rules (the
 * dashboard is the producer of an input: what it sends is checked as the app will check it), or null when the
 * contract refuses them. A request is sent in its canonical wire form (field order; a positional method's fields).
 */
function encode(method: DescMethod, args: readonly unknown[]): unknown[] | null {
  try {
    return toWireArguments(method, fromWireArguments(method, args));
  } catch (error) {
    if (error instanceof WireJsonError) return null;
    throw error;
  }
}

/** The input the contract refuses is never sent: the call answers invalid_input, as the app would. */
const refused: OpsCall<never> = { ok: false, code: 'invalid_input' };

// ---- one wrapper per declared method ---------------------------------------------------------------

/** The methods each app's entrypoint has (the generated services it implements); a test compares them with the IDL. */
export const CALLED_METHODS = {
  'mail-hero': ['status', 'setGuard', 'startCanary', 'canaryDelivery'],
  todofy: ['status', 'setGuard', 'canaryResult', 'reportOps'],
  lab: ['status', 'setGuard'],
} as const;

type Bindings = Pick<Env, 'MAIL_HERO' | 'TODOFY' | 'LAB'>;

function missing(): Promise<never> {
  return Promise.reject(new MissingBinding('not_configured'));
}

export function opsStatus(env: Bindings, app: OpsApp): Promise<OpsCall<ops.OpsStatus>> {
  return callOps(() => {
    if (app === 'mail-hero') return (env.MAIL_HERO as Bindings['MAIL_HERO'] | undefined)?.status() ?? missing();
    if (app === 'lab') return (env.LAB as Bindings['LAB'] | undefined)?.status() ?? missing();
    return (env.TODOFY as Bindings['TODOFY'] | undefined)?.status() ?? missing();
  }, asStatus(app));
}

export async function opsSetGuard(env: Bindings, app: OpsApp, input: ops.SetGuardInput): Promise<OpsCall<ops.GuardState>> {
  const args = encode(OpsService.method.setGuard, [input]);
  if (args === null) return refused;
  const sent = args[0] as ops.SetGuardInput;
  return callOps(() => {
    if (app === 'mail-hero') return (env.MAIL_HERO as Bindings['MAIL_HERO'] | undefined)?.setGuard(sent) ?? missing();
    if (app === 'lab') return (env.LAB as Bindings['LAB'] | undefined)?.setGuard(sent) ?? missing();
    return (env.TODOFY as Bindings['TODOFY'] | undefined)?.setGuard(sent) ?? missing();
  }, asGuardState);
}

export async function opsStartCanary(env: Bindings, input: ops.StartCanaryInput): Promise<OpsCall<ops.StartCanaryResult>> {
  const args = encode(CanaryProducerService.method.startCanary, [input]);
  if (args === null) return refused;
  const sent = args[0] as ops.StartCanaryInput;
  return callOps(() => (env.MAIL_HERO as Bindings['MAIL_HERO'] | undefined)?.startCanary(sent) ?? missing(), asStartCanaryResult);
}

export async function opsCanaryDelivery(env: Bindings, eventId: string): Promise<OpsCall<ops.CanaryDelivery>> {
  const args = encode(CanaryProducerService.method.canaryDelivery, [eventId]);
  if (args === null) return refused;
  const sent = args[0] as string;
  return callOps(() => (env.MAIL_HERO as Bindings['MAIL_HERO'] | undefined)?.canaryDelivery(sent) ?? missing(), asCanaryDelivery);
}

export async function opsCanaryResult(env: Bindings, eventId: string): Promise<OpsCall<ops.CanaryResult>> {
  const args = encode(CanaryConsumerService.method.canaryResult, [eventId]);
  if (args === null) return refused;
  const sent = args[0] as string;
  return callOps(() => (env.TODOFY as Bindings['TODOFY'] | undefined)?.canaryResult(sent) ?? missing(), asCanaryResult);
}

export async function opsReportOps(env: Bindings, report: ops.OpsReport): Promise<OpsCall<ops.OpsReportReceipt>> {
  const args = encode(OpsDigestService.method.reportOps, [report]);
  if (args === null) return refused;
  const sent = args[0] as ops.OpsReport;
  return callOps(() => (env.TODOFY as Bindings['TODOFY'] | undefined)?.reportOps(sent) ?? missing(), asReceipt);
}
