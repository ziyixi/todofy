/**
 * task-intent-v1: the value rules of the contract (README.md) that its protobuf IDL cannot express. The
 * messages, enums and the service are generated from proto/todofy/taskintent/v1/task_intent.proto
 * (`@ziyixi/proto/todofy/taskintent/v1/task_intent_pb`, proto/README.md); the wire stays the JSON that
 * task-intent-v1.schema.json describes, read and written with `@ziyixi/proto/wire-json`.
 *
 * Dependency-free and erasable-only TypeScript, imported by relative path:
 *   lab/worker/src/…               '../../../contracts/task-intent-v1/task-intent-v1.ts'
 *   todofy/gateway/src/ops.ts      '../../../contracts/task-intent-v1/task-intent-v1.ts'
 * Todofy's core keeps the same values in worker/todofy/core/intents.py; a test on each side compares them
 * with task-intent-v1.schema.json.
 */

/** The `version` field of every message (the proto package carries the major version as v1). */
export const TASK_INTENT_VERSION = 'task-intent-v1';

/**
 * Hosts each source (its wire name) may link to; Todofy refuses any other with url_not_allowed and never
 * fetches them.
 */
export const TASK_INTENT_URL_HOSTS: Readonly<Record<string, readonly string[]>> = {
  lab: ['arxiv.org'],
  // A task links to the change in the watch app (/watches/<id>), never to a watched page.
  watch: ['watch.ziyixi.science'],
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
  /** The largest retry_after_seconds a result carries (one day). */
  retryAfterMaxSeconds: 86400,
} as const;
