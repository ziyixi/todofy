/**
 * The only code that calls the apps (docs/design.md §5.1): one wrapper per method of `MailHeroOps` /
 * `TodofyOps` / `LabOps` in contracts/ops-v1/ops-v1.ts, each with a timeout, the contract's error codes and
 * validation of the answer against the contract schema. Results are values, never exceptions.
 */
import contractSchema from '../../../contracts/ops-v1/ops-v1.schema.json';
import { validate } from '../../../contracts/ops-v1/validate.mjs';
import {
  OPS_ERROR_CODES,
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
    return { ok: false, code: (OPS_ERROR_CODES as readonly string[]).includes(message) ? (message as OpsErrorCode) : 'unavailable' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---- contract validation ----------------------------------------------------------------------------
//
// Every answer is checked against contracts/ops-v1/ops-v1.schema.json with the contract's own validator
// (validate.mjs), so a buggy release cannot put free text, an address or an extra field into this
// object's storage or onto the page. Two consumer rules of the contract (README "Versioning") are
// applied first, because an app may ship an additive change before this Worker is redeployed:
//   - unknown fields are ignored: they are removed before validation and never stored;
//   - new values of the enums `reason`, `waiting_code` and `error_code` are allowed when they are codes
//     (`^[a-z][a-z0-9_]{0,47}$`); the UI shows unknown codes generically.

type Schema = Record<string, unknown>;
interface Root {
  readonly $defs: Record<string, unknown>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Output fields whose enum may grow within ops-v1. */
export const ADDITIVE_ENUM_FIELDS: readonly string[] = ['reason', 'waiting_code', 'error_code'];
const CODE_REF = { $ref: '#/$defs/Code' };

/** A copy of `node` where every additive enum property is widened to `Code`. */
function widen(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(widen);
  if (!isObject(node)) return node;
  const out: Schema = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties' && isObject(value)) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, property]) => [
          name,
          ADDITIVE_ENUM_FIELDS.includes(name) && isObject(property) && Array.isArray(property.enum) ? CODE_REF : widen(property),
        ]),
      );
    } else {
      out[key] = widen(value);
    }
  }
  return out;
}

/** The schema this consumer validates with (inputs keep their closed enums; only outputs are read here). */
export const CONSUMER_SCHEMA: Root = widen(contractSchema) as Root;

function resolve(schema: unknown): Schema | null {
  if (!isObject(schema)) return null;
  const ref = schema.$ref;
  if (typeof ref === 'string') {
    const name = /^#\/\$defs\/([A-Za-z0-9_]+)$/.exec(ref)?.[1];
    return name === undefined ? null : resolve(CONSUMER_SCHEMA.$defs[name]);
  }
  return schema;
}

/** The schemas of `key` in `schema` (a closed object, or a oneOf/anyOf of them); null when any branch is open. */
function declared(schema: Schema): Map<string, unknown> | null {
  const branches = [...((schema.oneOf as unknown[] | undefined) ?? []), ...((schema.anyOf as unknown[] | undefined) ?? [])];
  const out = new Map<string, unknown>();
  for (const branch of branches.length > 0 ? branches : [schema]) {
    const resolved = resolve(branch);
    if (resolved === null) continue;
    if (resolved.additionalProperties !== false || !isObject(resolved.properties)) {
      // A map (Metrics, Modes, Counters) or a union with a non-object branch: keep every key.
      if (resolved.type === 'object' || resolved.properties !== undefined) return null;
      continue;
    }
    for (const [name, property] of Object.entries(resolved.properties)) if (!out.has(name)) out.set(name, property);
  }
  return out;
}

/** `value` without the object fields the schema does not declare (recursively). */
export function withoutUnknownFields(schema: unknown, value: unknown): unknown {
  const resolved = resolve(schema);
  if (resolved === null) return value;
  if (Array.isArray(value)) return resolved.items === undefined ? value : value.map((item) => withoutUnknownFields(resolved.items, item));
  if (!isObject(value)) return value;
  const keys = declared(resolved);
  if (keys === null) return value;
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(value)) {
    if (keys.has(name)) out[name] = withoutUnknownFields(keys.get(name), field);
  }
  return out;
}

/** The value as the contract allows this consumer to read it, or null when it is not a valid `name`. */
export function conform(name: string, value: unknown): unknown {
  const cleaned = withoutUnknownFields(CONSUMER_SCHEMA.$defs[name], value);
  return validate(CONSUMER_SCHEMA, name, cleaned).length === 0 ? cleaned : null;
}

/** A guard for callOps: the conformed value, or null. */
export type Conformer<T> = (value: unknown) => T | null;

const conformer =
  <T>(name: string): Conformer<T> =>
  (value) =>
    conform(name, value) as T | null;

export const asGuardState: Conformer<GuardState> = conformer('GuardState');
export const asStartCanaryResult: Conformer<StartCanaryResult> = conformer('StartCanaryResult');
export const asCanaryDelivery: Conformer<CanaryDelivery> = conformer('CanaryDelivery');
export const asCanaryResult: Conformer<CanaryResult> = conformer('CanaryResult');
export const asReceipt: Conformer<OpsReportReceipt> = conformer('OpsReportReceipt');

/** An OpsStatus of `app` (the schema allows either app). */
export function asStatus(app: OpsApp): Conformer<OpsStatus> {
  return (value) => {
    const status = conform('OpsStatus', value) as OpsStatus | null;
    return status !== null && status.app === app ? status : null;
  };
}

// ---- one wrapper per declared method ---------------------------------------------------------------

/** The declared methods, by app (ops-v1.ts `MailHeroOps` / `TodofyOps`); a test compares them with the file. */
export const CALLED_METHODS = {
  'mail-hero': ['status', 'setGuard', 'startCanary', 'canaryDelivery'],
  todofy: ['status', 'setGuard', 'canaryResult', 'reportOps'],
  lab: ['status', 'setGuard'],
} as const;

type Bindings = Pick<Env, 'MAIL_HERO' | 'TODOFY' | 'LAB'>;

function missing(): Promise<never> {
  return Promise.reject(new MissingBinding('not_configured'));
}

export function opsStatus(env: Bindings, app: OpsApp): Promise<OpsCall<OpsStatus>> {
  return callOps(() => {
    if (app === 'mail-hero') return (env.MAIL_HERO as Bindings['MAIL_HERO'] | undefined)?.status() ?? missing();
    if (app === 'lab') return (env.LAB as Bindings['LAB'] | undefined)?.status() ?? missing();
    return (env.TODOFY as Bindings['TODOFY'] | undefined)?.status() ?? missing();
  }, asStatus(app));
}

export function opsSetGuard(env: Bindings, app: OpsApp, input: SetGuardInput): Promise<OpsCall<GuardState>> {
  return callOps(() => {
    if (app === 'mail-hero') return (env.MAIL_HERO as Bindings['MAIL_HERO'] | undefined)?.setGuard(input) ?? missing();
    if (app === 'lab') return (env.LAB as Bindings['LAB'] | undefined)?.setGuard(input) ?? missing();
    return (env.TODOFY as Bindings['TODOFY'] | undefined)?.setGuard(input) ?? missing();
  }, asGuardState);
}

export function opsStartCanary(env: Bindings, input: StartCanaryInput): Promise<OpsCall<StartCanaryResult>> {
  return callOps(() => (env.MAIL_HERO as Bindings['MAIL_HERO'] | undefined)?.startCanary(input) ?? missing(), asStartCanaryResult);
}

export function opsCanaryDelivery(env: Bindings, eventId: string): Promise<OpsCall<CanaryDelivery>> {
  return callOps(() => (env.MAIL_HERO as Bindings['MAIL_HERO'] | undefined)?.canaryDelivery(eventId) ?? missing(), asCanaryDelivery);
}

export function opsCanaryResult(env: Bindings, eventId: string): Promise<OpsCall<CanaryResult>> {
  return callOps(() => (env.TODOFY as Bindings['TODOFY'] | undefined)?.canaryResult(eventId) ?? missing(), asCanaryResult);
}

export function opsReportOps(env: Bindings, report: OpsReport): Promise<OpsCall<OpsReportReceipt>> {
  return callOps(() => (env.TODOFY as Bindings['TODOFY'] | undefined)?.reportOps(report) ?? missing(), asReceipt);
}
