/**
 * ops-v1: types of the named WorkerEntrypoint "Ops" that Mail Hero and Todofy export
 * (README.md). Dependency-free and erasable-only TypeScript (no enums, namespaces or parameter
 * properties), so it compiles under both apps' tsconfig and Node's type stripping can import it.
 *
 * Import it by relative path:
 *   mail-hero/cloudflare/src/native/ops.ts  '../../../../contracts/ops-v1/ops-v1.ts'
 *   todofy/gateway/src/ops.ts               '../../../contracts/ops-v1/ops-v1.ts'
 * Use `import type` for the types. The few constants below are the bounds every side enforces;
 * test/ops-contract.test.mjs (Mail Hero) checks them against ops-v1.schema.json.
 */

export const OPS_VERSION = 'ops-v1';
export const OPS_APPS = ['mail-hero', 'todofy'] as const;
export const OPS_SEVERITIES = ['info', 'warning', 'critical'] as const;
export const OPS_HEALTH = ['ok', 'degraded', 'down'] as const;
export const GUARD_LEVELS = ['normal', 'shed'] as const;
export const OPS_ERROR_CODES = ['invalid_input', 'busy', 'unavailable'] as const;
export const CANARY_PAUSED_REASONS = ['send_paused', 'settings_paused', 'endpoint_paused', 'endpoint_blocked'] as const;
export const CANARY_UNAVAILABLE_REASONS = ['maintenance', 'backup_active', 'no_endpoint', 'capacity'] as const;
export const CANARY_WAITING_CODES = ['maintenance', 'processing_paused', 'backup_active', 'retry_wait'] as const;

/** Bounds shared by producers, consumers and the schema (seconds, counts, bytes). */
export const OPS_LIMITS = {
  /** setGuard: `until` at most this far ahead of the app's clock. */
  guardMaxAheadSeconds: 36 * 3600,
  /** The digest uses the stored report while its generated_at is at most this old. */
  digestWindowSeconds: 36 * 3600,
  /** reportOps: generated_at may be at most this far ahead of Todofy's clock (clock skew). */
  reportFutureSkewSeconds: 300,
  reportMaxItems: 20,
  /** Compact JSON (JSON.stringify without spaces) of one OpsReport. */
  reportMaxBytes: 8192,
  statusMaxSignals: 16,
  metricsMaxKeys: 12,
  modesMaxKeys: 12,
  countersMaxKeys: 32,
  capabilitiesMax: 16,
  deferredMax: 16,
  /** Callers poll status() no more often than this (each call runs a few bounded D1 queries). */
  statusMinIntervalSeconds: 600,
} as const;

export type OpsApp = (typeof OPS_APPS)[number];
export type OpsSeverity = (typeof OPS_SEVERITIES)[number];
export type OpsHealth = (typeof OPS_HEALTH)[number];
export type GuardLevel = (typeof GUARD_LEVELS)[number];
export type OpsErrorCode = (typeof OPS_ERROR_CODES)[number];
export type CanaryPausedReason = (typeof CANARY_PAUSED_REASONS)[number];
export type CanaryUnavailableReason = (typeof CANARY_UNAVAILABLE_REASONS)[number];
export type CanaryWaitingCode = (typeof CANARY_WAITING_CODES)[number];

/** RFC 3339 UTC ending in Z, optional milliseconds: `2026-09-29T08:00:00Z`, `...:00.000Z`. */
export type Timestamp = string;
/** `^[a-z][a-z0-9_]{0,47}$`: signal codes, metric/counter/mode names, reasons. Never free text. */
export type Code = string;
/** Lowercase UUID, as Mail Hero writes event IDs. */
export type EventId = string;
/** `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, e.g. `canary-2026-09-29`. */
export type RunId = string;
/** Numbers only, at most OPS_LIMITS.metricsMaxKeys keys. */
export type Metrics = Readonly<Record<Code, number>>;

export interface OpsSignal {
  readonly code: Code;
  readonly severity: OpsSeverity;
  readonly metrics: Metrics;
  /** When the condition was first seen, if the app tracks it. */
  readonly since?: Timestamp;
}

/** Effective guard: an expired shed reads as normal with reason, until and set_at null. */
export interface GuardState {
  readonly level: GuardLevel;
  readonly reason: Code | null;
  readonly until: Timestamp | null;
  readonly set_at: Timestamp | null;
  /** Job codes deferred while shed (README.md, IMPLEMENTATION.md); empty when normal. */
  readonly deferred: readonly Code[];
}

export interface MailHeroModes {
  readonly maintenance: boolean;
  /** FORCE_SEND_PAUSED (deployment variable). */
  readonly force_send_paused: boolean;
  /** app_settings.send_paused (owner switch in the UI). */
  readonly send_paused: boolean;
  /** app_settings.mode is forward with a current endpoint. */
  readonly forwarding: boolean;
  /** A backup snapshot lease holds API writes and background work. */
  readonly backup_active: boolean;
}

export interface TodofyModes {
  readonly maintenance: boolean;
  readonly processing_paused: boolean;
  readonly force_pause_todoist: boolean;
  readonly reminder_enabled: boolean;
  /** The weekly backup job holds the ledger. */
  readonly backup_active: boolean;
}

export interface OpsStatus<
  A extends OpsApp = OpsApp,
  M extends { readonly maintenance: boolean } = { readonly maintenance: boolean } & Readonly<Record<Code, boolean>>,
> {
  readonly version: typeof OPS_VERSION;
  readonly app: A;
  readonly generated_at: Timestamp;
  readonly health: OpsHealth;
  readonly modes: M;
  readonly guard: GuardState;
  /** Active signals only, at most OPS_LIMITS.statusMaxSignals. */
  readonly signals: readonly OpsSignal[];
  /** Numbers only; a counter the app could not read is left out. */
  readonly counters: Readonly<Record<Code, number>>;
  readonly last_backup_at: Timestamp | null;
  /** The app's owner UI, `https://<host>/`; null when the app does not know its host. */
  readonly ui_url: string | null;
  /** e.g. `canary_producer`, `canary_consumer`, `guard`, `ops_digest`. */
  readonly capabilities: readonly Code[];
}
export type MailHeroStatus = OpsStatus<'mail-hero', MailHeroModes>;
export type TodofyStatus = OpsStatus<'todofy', TodofyModes>;

export type SetGuardInput =
  | { readonly level: 'shed'; readonly reason: Code; readonly until: Timestamp }
  | { readonly level: 'normal'; readonly reason: Code; readonly until: null };

export interface StartCanaryInput {
  readonly run_id: RunId;
}

/** Only `queued` created anything; `paused` and `unavailable` wrote nothing and may be retried. */
export type StartCanaryResult =
  | { readonly event_id: EventId; readonly state: 'queued' }
  | { readonly event_id: null; readonly state: 'paused'; readonly reason: CanaryPausedReason }
  | { readonly event_id: null; readonly state: 'unavailable'; readonly reason: CanaryUnavailableReason };

export type CanaryDelivery =
  | {
      readonly state: 'delivered';
      readonly attempts: number;
      readonly last_http_status?: number;
      readonly delivered_at: Timestamp;
    }
  | {
      readonly state: 'pending' | 'paused';
      readonly attempts: number;
      readonly last_http_status?: number;
      /** Mail Hero's last delivery error code (e.g. `http_503`, `network_error`). */
      readonly error_code?: Code;
    }
  | { readonly state: 'failed'; readonly attempts: number; readonly last_http_status?: number; readonly error_code: Code }
  /** No canary delivery with this event ID (also for a real mail's event ID). */
  | { readonly state: 'unknown'; readonly attempts: 0 };

export type CanaryResult =
  /** No canary event with this ID (also for a real mail's event ID). */
  | { readonly state: 'not_seen' }
  | { readonly state: 'processing'; readonly waiting_code?: CanaryWaitingCode }
  | { readonly state: 'ok'; readonly completed_at: Timestamp }
  | { readonly state: 'failed'; readonly completed_at: Timestamp; readonly error_code: Code };

export interface OpsReportItem {
  /** `^[a-z][a-z0-9-]{0,31}$`: `mail-hero`, `todofy`, `dashboard`, ... */
  readonly source: string;
  readonly code: Code;
  readonly severity: OpsSeverity;
  readonly since: Timestamp;
  readonly metrics: Metrics;
}

export interface OpsReport {
  readonly generated_at: Timestamp;
  /** At most OPS_LIMITS.reportMaxItems. Only warning and critical items reach the digest. */
  readonly items: readonly OpsReportItem[];
  /** Linked from the digest when present. */
  readonly dashboard_url?: string;
}

export interface OpsReportReceipt {
  /** False when a report with a later generated_at is already stored (then it describes that one). */
  readonly stored: boolean;
  readonly generated_at: Timestamp;
  readonly item_count: number;
}

/**
 * Methods reject only with `new Error(code)` where code is an OpsErrorCode; every expected outcome
 * (paused, unavailable, not_seen, ...) is a value. A caller treats any other rejection (binding
 * down, deploy in progress) like `unavailable`.
 */
export interface OpsCommon<S> {
  status(): Promise<S>;
  setGuard(input: SetGuardInput): Promise<GuardState>;
}

/** `export class Ops extends WorkerEntrypoint<Env> implements MailHeroOps` in mail-hero. */
export interface MailHeroOps extends OpsCommon<MailHeroStatus> {
  startCanary(input: StartCanaryInput): Promise<StartCanaryResult>;
  canaryDelivery(eventId: EventId): Promise<CanaryDelivery>;
}

/** `export class Ops extends WorkerEntrypoint<Env> implements TodofyOps` in todofy's gateway. */
export interface TodofyOps extends OpsCommon<TodofyStatus> {
  canaryResult(eventId: EventId): Promise<CanaryResult>;
  reportOps(report: OpsReport): Promise<OpsReportReceipt>;
}
