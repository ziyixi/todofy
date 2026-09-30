/**
 * The only code that calls the apps (docs/design.md §5.1): one wrapper per method of `MailHeroOps` /
 * `TodofyOps` in contracts/ops-v1/ops-v1.ts, each with a timeout, the contract's error codes and a
 * minimal shape guard over the fields the dashboard reads. Results are values, never exceptions.
 */
import {
  CANARY_WAITING_CODES,
  GUARD_LEVELS,
  OPS_ERROR_CODES,
  OPS_HEALTH,
  OPS_SEVERITIES,
  OPS_VERSION,
  type CanaryDelivery,
  type CanaryResult,
  type GuardState,
  type OpsApp,
  type OpsErrorCode,
  type OpsReport,
  type OpsReportReceipt,
  type OpsStatus,
  type SetGuardInput,
  type StartCanaryInput,
  type StartCanaryResult,
} from '../../../contracts/ops-v1/ops-v1.ts';
import type { AppErrorCode } from './api-types.ts';
import type { Env } from './env.ts';

export const OPS_TIMEOUT_MS = 10_000;
/** An answer larger than this (as JSON) is `invalid_output`; the contract's bounds keep real ones far smaller. */
export const OPS_MAX_JSON_CHARS = 32_768;

export type OpsCall<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: AppErrorCode };

const TIMEOUT = Symbol('timeout');

/** The binding is absent from this deployment (a local config without it). */
class MissingBinding extends Error {}

/** Runs one RPC call with a timeout and maps every outcome to a value (§5.1). */
export async function callOps<T>(
  invoke: () => PromiseLike<unknown>,
  guard: (value: unknown) => value is T,
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
    if (size > OPS_MAX_JSON_CHARS || !guard(value)) return { ok: false, code: 'invalid_output' };
    return { ok: true, value };
  } catch (error) {
    if (error instanceof MissingBinding) return { ok: false, code: 'not_configured' };
    const message = error instanceof Error ? error.message : '';
    return { ok: false, code: (OPS_ERROR_CODES as readonly string[]).includes(message) ? (message as OpsErrorCode) : 'unavailable' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---- shape guards (the fields the dashboard reads; the full schema is checked in tests) ------------

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isStringOrNull = (value: unknown): boolean => value === null || typeof value === 'string';
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const oneOf = (list: readonly string[], value: unknown): boolean => typeof value === 'string' && list.includes(value);
const isNumberRecord = (value: unknown): boolean =>
  isObject(value) && Object.values(value).every((v) => typeof v === 'number' && Number.isFinite(v));

export function isGuardState(value: unknown): value is GuardState {
  return (
    isObject(value) &&
    oneOf(GUARD_LEVELS, value.level) &&
    isStringOrNull(value.reason) &&
    isStringOrNull(value.until) &&
    isStringOrNull(value.set_at) &&
    Array.isArray(value.deferred) &&
    value.deferred.every(isString)
  );
}

function isSignal(value: unknown): boolean {
  return (
    isObject(value) &&
    isString(value.code) &&
    oneOf(OPS_SEVERITIES, value.severity) &&
    isNumberRecord(value.metrics) &&
    (value.since === undefined || isString(value.since))
  );
}

export function isStatus(app: OpsApp): (value: unknown) => value is OpsStatus {
  return (value: unknown): value is OpsStatus =>
    isObject(value) &&
    value.version === OPS_VERSION &&
    value.app === app &&
    isString(value.generated_at) &&
    oneOf(OPS_HEALTH, value.health) &&
    isObject(value.modes) &&
    typeof value.modes.maintenance === 'boolean' &&
    Object.values(value.modes).every((v) => typeof v === 'boolean') &&
    isGuardState(value.guard) &&
    Array.isArray(value.signals) &&
    value.signals.every(isSignal) &&
    isNumberRecord(value.counters) &&
    isStringOrNull(value.last_backup_at) &&
    isStringOrNull(value.ui_url) &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every(isString);
}

export function isStartCanaryResult(value: unknown): value is StartCanaryResult {
  if (!isObject(value)) return false;
  if (value.state === 'queued') return isString(value.event_id) && /^[0-9a-f-]{36}$/.test(value.event_id);
  return (value.state === 'paused' || value.state === 'unavailable') && value.event_id === null && isString(value.reason);
}

export function isCanaryDelivery(value: unknown): value is CanaryDelivery {
  if (!isObject(value) || !isCount(value.attempts)) return false;
  if (value.last_http_status !== undefined && !isCount(value.last_http_status)) return false;
  switch (value.state) {
    case 'delivered':
      return isString(value.delivered_at);
    case 'pending':
    case 'paused':
      return value.error_code === undefined || isString(value.error_code);
    case 'failed':
      return isString(value.error_code);
    case 'unknown':
      return true;
    default:
      return false;
  }
}

export function isCanaryResult(value: unknown): value is CanaryResult {
  if (!isObject(value)) return false;
  switch (value.state) {
    case 'not_seen':
      return true;
    case 'processing':
      return value.waiting_code === undefined || oneOf(CANARY_WAITING_CODES, value.waiting_code);
    case 'ok':
      return isString(value.completed_at);
    case 'failed':
      return isString(value.completed_at) && isString(value.error_code);
    default:
      return false;
  }
}

export function isReceipt(value: unknown): value is OpsReportReceipt {
  return isObject(value) && typeof value.stored === 'boolean' && isString(value.generated_at) && isCount(value.item_count);
}

// ---- one wrapper per declared method ---------------------------------------------------------------

/** The declared methods, by app (ops-v1.ts `MailHeroOps` / `TodofyOps`); a test compares them with the file. */
export const CALLED_METHODS = {
  'mail-hero': ['status', 'setGuard', 'startCanary', 'canaryDelivery'],
  todofy: ['status', 'setGuard', 'canaryResult', 'reportOps'],
} as const;

type Bindings = Pick<Env, 'MAIL_HERO' | 'TODOFY'>;

function missing(): Promise<never> {
  return Promise.reject(new MissingBinding('not_configured'));
}

export function opsStatus(env: Bindings, app: OpsApp): Promise<OpsCall<OpsStatus>> {
  return callOps(() => {
    if (app === 'mail-hero') return (env.MAIL_HERO as Bindings['MAIL_HERO'] | undefined)?.status() ?? missing();
    return (env.TODOFY as Bindings['TODOFY'] | undefined)?.status() ?? missing();
  }, isStatus(app));
}

export function opsSetGuard(env: Bindings, app: OpsApp, input: SetGuardInput): Promise<OpsCall<GuardState>> {
  return callOps(() => {
    if (app === 'mail-hero') return (env.MAIL_HERO as Bindings['MAIL_HERO'] | undefined)?.setGuard(input) ?? missing();
    return (env.TODOFY as Bindings['TODOFY'] | undefined)?.setGuard(input) ?? missing();
  }, isGuardState);
}

export function opsStartCanary(env: Bindings, input: StartCanaryInput): Promise<OpsCall<StartCanaryResult>> {
  return callOps(() => (env.MAIL_HERO as Bindings['MAIL_HERO'] | undefined)?.startCanary(input) ?? missing(), isStartCanaryResult);
}

export function opsCanaryDelivery(env: Bindings, eventId: string): Promise<OpsCall<CanaryDelivery>> {
  return callOps(() => (env.MAIL_HERO as Bindings['MAIL_HERO'] | undefined)?.canaryDelivery(eventId) ?? missing(), isCanaryDelivery);
}

export function opsCanaryResult(env: Bindings, eventId: string): Promise<OpsCall<CanaryResult>> {
  return callOps(() => (env.TODOFY as Bindings['TODOFY'] | undefined)?.canaryResult(eventId) ?? missing(), isCanaryResult);
}

export function opsReportOps(env: Bindings, report: OpsReport): Promise<OpsCall<OpsReportReceipt>> {
  return callOps(() => (env.TODOFY as Bindings['TODOFY'] | undefined)?.reportOps(report) ?? missing(), isReceipt);
}
