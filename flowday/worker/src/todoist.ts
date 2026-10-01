/**
 * Todoist, read only. FlowDay is a read-only view of Todoist plus its own time blocks; Todofy is the only writer
 * of Todoist (root AGENTS.md). This module therefore calls exactly one endpoint, the Sync API read
 * (POST /api/v1/sync with `sync_token` and `resource_types`), and never sends `commands`.
 *
 * Incremental sync: with the `sync_token` of the previous answer Todoist returns only the items and projects
 * that changed since then (completed and deleted ones flagged), so a quiet day reads almost nothing. The token
 * "*" (first sync, a new API key) returns everything with `full_sync: true`; Todoist may also answer a stored
 * token with a full sync, which the caller treats the same way.
 */
import type { TaskPriority } from './api-types.ts';
import type { TaskUpsertRow } from './store/tasks.ts';

export const TODOIST_SYNC_URL = 'https://api.todoist.com/api/v1/sync';
export const FULL_SYNC_TOKEN = '*';
export const RESOURCE_TYPES = ['items', 'projects'] as const;
/**
 * Upper bounds on one answer. Todoist sends a full sync in one piece, so parsing it is the one cost that grows with
 * the account inside a single request; the sync applies it in chunks over several requests (../sync.ts), but every
 * request still parses the whole answer. These bounds keep that parse, on an isolate's cold first request, well
 * inside Workers Free's 10 ms of CPU (worker/test/runtime/cpu.test.ts measures it with full Todoist item shapes).
 * A larger answer is refused as `too_large` before it is parsed, and the body is counted in bytes as it streams in.
 */
export const MAX_SYNC_ITEMS = 1000;
export const MAX_SYNC_BYTES = 1024 * 1024;
/** One day of work time, as the container era converted day durations. */
export const MINUTES_PER_DAY = 480;

export const TODOIST_COLORS: Readonly<Record<string, string>> = {
  berry_red: '#b8255f',
  red: '#db4035',
  orange: '#ff9933',
  yellow: '#fad000',
  olive_green: '#afb83b',
  lime_green: '#7ecc49',
  green: '#299438',
  mint_green: '#6accbc',
  teal: '#158fad',
  sky_blue: '#14aaf5',
  light_blue: '#96c3eb',
  blue: '#4073ff',
  grape: '#884dff',
  violet: '#af38eb',
  lavender: '#eb96eb',
  magenta: '#e05194',
  salmon: '#ff8d85',
  charcoal: '#808080',
  grey: '#b8b8b8',
  taupe: '#ccac93',
};

export function todoistColorToHex(colorName: string): string {
  return TODOIST_COLORS[colorName] ?? '#808080';
}

/** The fields FlowDay reads from a Sync API item (others are ignored). */
export interface TodoistItem {
  id: string;
  content: string;
  description: string;
  project_id: string;
  priority: number;
  labels: string[];
  due: { date: string } | null;
  duration: { amount: number; unit: string } | null;
  added_at: string | null;
  completed_at: string | null;
  checked: boolean;
  is_deleted: boolean;
}

export interface TodoistProject {
  id: string;
  name: string;
  color: string;
  is_deleted: boolean;
  is_archived: boolean;
}

export interface SyncAnswer {
  syncToken: string;
  fullSync: boolean;
  items: TodoistItem[];
  projects: TodoistProject[];
}

export type TodoistFailure = 'unauthorized' | 'unavailable' | 'invalid_answer' | 'too_large';

export class TodoistError extends Error {
  readonly failure: TodoistFailure;
  readonly status: number | null;

  constructor(failure: TodoistFailure, status: number | null = null) {
    super(`todoist_${failure}`);
    this.failure = failure;
    this.status = status;
  }
}

/** The request body: the token and the two resource types, nothing else (never `commands`). */
export function syncRequestBody(syncToken: string): URLSearchParams {
  return new URLSearchParams({ sync_token: syncToken, resource_types: JSON.stringify(RESOURCE_TYPES) });
}

/** One read of the Sync API. Throws TodoistError; never logs the token or any task content. */
export async function fetchSync(apiKey: string, syncToken: string, fetcher: typeof fetch = fetch): Promise<SyncAnswer> {
  let response: Response;
  try {
    response = await fetcher(TODOIST_SYNC_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: syncRequestBody(syncToken),
      redirect: 'manual',
    });
  } catch {
    throw new TodoistError('unavailable');
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new TodoistError('unauthorized', response.status);
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new TodoistError('unavailable', response.status);
  }
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_SYNC_BYTES) {
    await response.body?.cancel();
    throw new TodoistError('too_large');
  }
  const text = await readCapped(response, MAX_SYNC_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TodoistError('invalid_answer');
  }
  return parseSyncAnswer(value);
}

/**
 * The body as text, refused as `too_large` when it has more than `maxBytes` (decoded) bytes, before any of it is
 * decoded or parsed. The body is read whole by the runtime (no JavaScript per network chunk: a read loop cost about
 * 2 ms of CPU for a 1 MiB answer); Todoist is the only origin, so its size cannot exhaust memory.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<string> {
  let bytes: ArrayBuffer;
  try {
    bytes = await response.arrayBuffer();
  } catch {
    throw new TodoistError('unavailable');
  }
  if (bytes.byteLength > maxBytes) throw new TodoistError('too_large');
  return new TextDecoder().decode(bytes);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null;
}

function flag(value: unknown): boolean {
  return value === true || value === 1;
}

function parseItem(raw: unknown): TodoistItem | null {
  const item = record(raw);
  const id = str(item?.['id']);
  if (item === null || id === null) return null;
  const due = record(item['due']);
  const duration = record(item['duration']);
  const amount = duration?.['amount'];
  const unit = duration?.['unit'];
  return {
    id,
    content: str(item['content']) ?? '',
    description: str(item['description']) ?? '',
    project_id: str(item['project_id']) ?? '',
    priority: typeof item['priority'] === 'number' ? item['priority'] : 1,
    labels: Array.isArray(item['labels']) ? item['labels'].filter((label): label is string => typeof label === 'string') : [],
    due: due !== null && typeof due['date'] === 'string' ? { date: due['date'] } : null,
    duration: typeof amount === 'number' && typeof unit === 'string' ? { amount, unit } : null,
    added_at: str(item['added_at']) ?? str(item['created_at']),
    completed_at: str(item['completed_at']),
    checked: flag(item['checked']) || flag(item['is_completed']),
    is_deleted: flag(item['is_deleted']),
  };
}

function parseProject(raw: unknown): TodoistProject | null {
  const project = record(raw);
  const id = str(project?.['id']);
  if (project === null || id === null) return null;
  return {
    id,
    name: str(project['name']) ?? '',
    color: str(project['color']) ?? '',
    is_deleted: flag(project['is_deleted']),
    is_archived: flag(project['is_archived']),
  };
}

export function parseSyncAnswer(value: unknown): SyncAnswer {
  const answer = record(value);
  const syncToken = str(answer?.['sync_token']);
  if (answer === null || syncToken === null || syncToken === '' || syncToken.length > 512) throw new TodoistError('invalid_answer');
  const items = answer['items'] ?? [];
  const projects = answer['projects'] ?? [];
  if (!Array.isArray(items) || !Array.isArray(projects)) throw new TodoistError('invalid_answer');
  if (items.length > MAX_SYNC_ITEMS) throw new TodoistError('too_large');
  return {
    syncToken,
    fullSync: answer['full_sync'] === true,
    items: items.map(parseItem).filter((item): item is TodoistItem => item !== null),
    projects: projects.map(parseProject).filter((project): project is TodoistProject => project !== null),
  };
}

/** Minutes of a Todoist duration (days count as 480 minutes), or null when there is none. */
export function durationMinutes(duration: TodoistItem['duration']): number | null {
  if (duration === null) return null;
  if (duration.unit === 'minute') return duration.amount;
  if (duration.unit === 'day') return duration.amount * MINUTES_PER_DAY;
  return null;
}

/** A project as FlowDay stores it: display name and hex colour. */
export interface ProjectInfo {
  name: string;
  color: string;
}

/** The upsert row of an active Todoist item; `projects` resolves its project name and colour. */
export function itemToRow(item: TodoistItem, projects: ReadonlyMap<string, ProjectInfo>): TaskUpsertRow {
  const project = projects.get(item.project_id);
  const priority = (item.priority >= 1 && item.priority <= 4 ? item.priority : 1) as TaskPriority;
  return {
    id: item.id,
    todoist_id: item.id,
    title: item.content,
    description: item.description === '' ? null : item.description,
    project_name: project?.name ?? null,
    project_color: project?.color ?? null,
    priority,
    labels: JSON.stringify(item.labels),
    estimated_mins: durationMinutes(item.duration),
    is_completed: 0,
    completed_at: item.completed_at,
    // "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS": FlowDay plans by day.
    due_date: item.due === null ? null : item.due.date.slice(0, 10),
    created_at: item.added_at,
    todoist_project_id: item.project_id === '' ? null : item.project_id,
  };
}
