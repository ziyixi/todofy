/**
 * task-intent-v1: types of the two methods Todofy's gateway entrypoint "Ops" adds so that another app
 * (today only Lab) can propose Todoist tasks (README.md). Todofy stays the only Todoist writer.
 * Dependency-free and erasable-only TypeScript (no enums, namespaces or parameter properties), like
 * contracts/ops-v1/ops-v1.ts, so every Worker's tsconfig and Node's type stripping can import it.
 *
 * Import it by relative path:
 *   lab/worker/src/…               '../../../contracts/task-intent-v1/task-intent-v1.ts'
 *   todofy/gateway/src/ops.ts      '../../../contracts/task-intent-v1/task-intent-v1.ts'
 * The constants are the bounds every side enforces; a test on each side compares them with
 * task-intent-v1.schema.json.
 */

export const TASK_INTENT_VERSION = 'task-intent-v1';
export const TASK_INTENT_SOURCES = ['lab'] as const;
export const TASK_INTENT_MODES = ['subtasks', 'separate'] as const;
export const TASK_INTENT_STATES = ['pending', 'created', 'duplicate', 'paused', 'failed', 'rejected', 'not_found'] as const;
export const TASK_INTENT_ERROR_CODES = [
  'maintenance',
  'processing_paused',
  'todoist_paused',
  'todoist_blocked',
  'backup_active',
  'rate_limited',
  'retry_wait',
  'todoist_rejected',
  'todoist_result_unknown',
  'intent_conflict',
  'daily_limit',
  'url_not_allowed',
  'source_not_allowed',
] as const;

/** Hosts each source may link to (Todofy refuses any other with url_not_allowed; it never fetches them). */
export const TASK_INTENT_URL_HOSTS: Readonly<Record<TaskIntentSource, readonly string[]>> = {
  lab: ['arxiv.org'],
};

export const TASK_INTENT_LIMITS = {
  itemsMax: 30,
  /** Items plus the parent task in subtasks mode. */
  tasksMax: 31,
  parentTitleMax: 200,
  itemTitleMax: 300,
  descriptionMax: 1000,
  urlMax: 500,
  /** New intents Todofy records per source and UTC day; more are rejected with daily_limit. */
  intentsPerSourcePerDay: 10,
  /** Compact JSON (JSON.stringify without spaces) of one TaskIntent; the gateway refuses larger input. */
  intentMaxBytes: 65536,
  /** A proposer polls taskIntentStatus no more often than this while pending. */
  statusMinIntervalSeconds: 3,
} as const;

export type TaskIntentSource = (typeof TASK_INTENT_SOURCES)[number];
export type TaskIntentMode = (typeof TASK_INTENT_MODES)[number];
export type TaskIntentState = (typeof TASK_INTENT_STATES)[number];
export type TaskIntentErrorCode = (typeof TASK_INTENT_ERROR_CODES)[number];

/** RFC 3339 UTC ending in Z. */
export type Timestamp = string;
/** `^[a-z0-9][a-z0-9._-]{0,63}$`, unique per source for ever, e.g. `deck-2026-09-30-g1`. */
export type IntentId = string;

export interface TaskIntentParent {
  /** One line, 1–200 characters: the parent task's content (subtasks mode) or a context line (separate). */
  readonly title: string;
  /** Plain text, newlines allowed, at most 1000 characters. */
  readonly description?: string;
}

export interface TaskIntentItem {
  /** One line, 1–300 characters: the task's content. */
  readonly title: string;
  /** https, host on TASK_INTENT_URL_HOSTS[source], no query or fragment. */
  readonly url?: string;
  /** Plain text, newlines allowed, at most 1000 characters. */
  readonly description?: string;
}

export interface TaskIntent {
  readonly version: typeof TASK_INTENT_VERSION;
  readonly source: TaskIntentSource;
  readonly intent_id: IntentId;
  readonly mode: TaskIntentMode;
  readonly parent: TaskIntentParent;
  /** 1–30 distinct items, created in this order. */
  readonly items: readonly TaskIntentItem[];
}

export interface TaskIntentRef {
  readonly version: typeof TASK_INTENT_VERSION;
  readonly source: TaskIntentSource;
  readonly intent_id: IntentId;
}

/** Numbers, codes and the caller's own identifiers only: no task text, no Todoist IDs. */
export interface TaskIntentResult {
  readonly version: typeof TASK_INTENT_VERSION;
  readonly source: TaskIntentSource;
  readonly intent_id: IntentId;
  readonly state: TaskIntentState;
  /** Todofy holds this intent (content frozen there); false for rejected-new, paused-new and not_found. */
  readonly recorded: boolean;
  /** Items, plus the parent in subtasks mode; 0 when not recorded. */
  readonly tasks_total: number;
  readonly tasks_created: number;
  readonly error_code: TaskIntentErrorCode | null;
  /** When to ask again; null when there is nothing to wait for. */
  readonly retry_after_seconds: number | null;
  readonly updated_at: Timestamp;
}

/**
 * The methods on Todofy's `Ops` entrypoint (service binding `TODOFY`, entrypoint "Ops"). Like ops-v1, a
 * method rejects only with `new Error(code)`, code in `invalid_input` (the input fails the schema; do not
 * retry unchanged), `busy`, `unavailable`; a caller treats any other rejection (binding error, deploy in
 * progress, an older Todofy without these methods) like `unavailable`. Every expected outcome is a value.
 */
export interface TaskIntentOps {
  proposeTasks(intent: TaskIntent): Promise<TaskIntentResult>;
  taskIntentStatus(ref: TaskIntentRef): Promise<TaskIntentResult>;
}
