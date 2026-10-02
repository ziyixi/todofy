/**
 * The owner API's bounds (proto/flowday/ui/v1 states each in its field's comment). The page sizes keep every answer
 * well inside Workers Free's 10 ms of CPU per request: writing a message in the wire JSON profile costs a few
 * microseconds per task or time entry (../test/runtime/cpu.test.ts measures the largest pages).
 */

/** Request bodies: a day's flow, a note (markdown) or a settings change; nothing larger. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Task IDs in one flow, rollover or ID list. */
export const MAX_IDS = 2000;
/** A task's title and a local task's description, in characters. */
export const MAX_TITLE = 2000;
/** A local task's labels. */
export const MAX_LABELS = 50;
/** A note, in characters. */
export const MAX_NOTE = 100_000;
/** A task's estimate, in minutes. */
export const MAX_ESTIMATE_MINUTES = 100_000;
/** The day's capacity, in minutes. */
export const MAX_DAY_CAPACITY_MINUTES = 1440;
/** The Todoist API key, in characters (trimmed). */
export const MAX_TODOIST_KEY = 200;
/** A task ID the timer session holds, in characters. */
export const MAX_SESSION_ID = 200;

/** ListTasks: the largest page (the sync keeps at most 1,000 Todoist tasks). */
export const TASK_PAGE = 200;
/** ListFlows: the largest page, in days. */
export const FLOW_PAGE = 200;
/** ListNotes: the largest page (a note may hold MAX_NOTE characters). */
export const NOTE_PAGE = 100;
/** ListTimeEntries: the largest page. */
export const ENTRY_PAGE = 200;
/** QueryAnalytics: the largest page of time entries (each page also carries the tasks its entries name). */
export const ANALYTICS_PAGE = 200;
