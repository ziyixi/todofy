/**
 * POST /api/sync: bring Todoist's changes into D1 with as few D1 row writes as possible (../../docs/design.md
 * "Todoist sync" and "Write budget"). FlowDay only reads Todoist (./todoist.ts).
 *
 * 1. One read of the settings (sealed key, sync token, projects, claim, last sync, pending pass).
 * 2. Atomic throttle: a compare-and-set of `sync_claimed_at` that only succeeds when the stored claim is still the
 *    one read in step 1 and older than the minimum interval. Concurrent tabs or devices cannot both win. 1 row.
 * 3. One Todoist Sync API read with the stored sync token: only what changed since the last sync.
 * 4. One atomic D1 batch that applies at most SYNC_CHUNK items, in id order: diff upserts of the active ones,
 *    hiding of completed or deleted ones and of the tasks of archived or deleted projects, renamed projects,
 *    `last_sync_at`, and either the new sync token (the answer is fully applied) or the pending pass (more chunks
 *    follow, applied by the next requests). A sync with no Todoist change writes 2 rows (claim, last_sync_at).
 *
 * Bounded work per request: a large answer (the first full sync of a big account) is applied over several requests,
 * each re-reading the answer and applying the next chunk, so no request upserts more than SYNC_CHUNK items. Until
 * the last chunk the stored token stays as it was; the pending pass keeps the token of the pass's first answer,
 * so anything that changed during the pass comes back in the next incremental sync.
 *
 * Failure backoff: a claim that was not followed by a successful sync (a Todoist error, or an isolate stopped
 * mid-request) doubles the automatic interval, up to 32 times. A failing full sync therefore cannot repeat every
 * 5 minutes all day. "Sync now" keeps its 30 seconds.
 */
import type { SyncResponse } from './api-types.ts';
import { importCredentialKey, openCredential } from './credentials.ts';
import { batchSql, type Db } from './db.ts';
import { getSettings, setSettingSql } from './store/settings.ts';
import { UPSERT_CHUNK, hideProjectsStatement, hideStatement, orphanStatement, projectStatement, upsertStatements } from './store/tasks.ts';
import { FULL_SYNC_TOKEN, fetchSync, itemToRow, todoistColorToHex, type ProjectInfo, type SyncAnswer, type TodoistItem } from './todoist.ts';
import { sql, type SQL } from 'drizzle-orm';

export const AUTO_SYNC_MIN_INTERVAL_MS = 5 * 60_000;
export const MANUAL_SYNC_MIN_INTERVAL_MS = 30_000;
/** The automatic interval doubles after each failed sync, up to 2^5 = 32 times (160 minutes). */
export const MAX_BACKOFF_STEPS = 5;
/** Items applied per request (one upsert statement). */
export const SYNC_CHUNK = UPSERT_CHUNK;

export const KEY_API_KEY = 'todoist_api_key';
export const KEY_SYNC_TOKEN = 'todoist_sync_token';
export const KEY_PROJECTS = 'todoist_projects';
export const KEY_CLAIMED_AT = 'sync_claimed_at';
export const KEY_LAST_SYNC_AT = 'last_sync_at';
export const KEY_PENDING = 'todoist_sync_pending';

export type SyncMode = 'auto' | 'manual';

export type SyncOutcome =
  | { kind: 'ok'; response: SyncResponse }
  | { kind: 'no_key' }
  | { kind: 'key_unreadable' }
  | { kind: 'not_configured' }
  | { kind: 'todoist'; failure: 'unauthorized' | 'unavailable' | 'invalid_answer' | 'too_large' };

// ---- stored state ----------------------------------------------------------------------------------------------

/** The stored project map: {id: [name, hex colour]}, keys sorted so an unchanged map serialises identically. */
export function parseProjects(raw: string | null): Map<string, ProjectInfo> {
  const out = new Map<string, ProjectInfo>();
  if (raw === null) return out;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return out;
    for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') {
        out.set(id, { name: entry[0], color: entry[1] });
      }
    }
  } catch {
    // A damaged map is rebuilt by the next full sync.
  }
  return out;
}

export function serializeProjects(projects: ReadonlyMap<string, ProjectInfo>): string {
  const ids = [...projects.keys()].sort();
  return JSON.stringify(Object.fromEntries(ids.map((id) => [id, [projects.get(id)?.name ?? '', projects.get(id)?.color ?? '']])));
}

/** `sync_claimed_at`: "<epoch ms>" or "<epoch ms>:<failed syncs before it>". */
export interface Claim {
  at: number;
  failures: number;
}

export function parseClaim(raw: string | null | undefined): Claim | null {
  const match = /^(\d{1,16})(?::(\d{1,2}))?$/.exec(raw ?? '');
  if (match === null) return null;
  return { at: Number(match[1]), failures: Number(match[2] ?? '0') };
}

export function claimValue(claim: Claim): string {
  return claim.failures === 0 ? String(claim.at) : `${String(claim.at)}:${String(claim.failures)}`;
}

/**
 * A pass that is being applied over several requests: `base` is the token to ask Todoist with ("*" for a full
 * pass), `token` the sync token of the pass's first answer (stored when the pass ends; null until the first answer
 * arrives) and `after` the last item id applied.
 */
export interface Pending {
  base: string;
  token: string | null;
  after: string;
}

export function parsePending(raw: string | null | undefined): Pending | null {
  if (raw === null || raw === undefined) return null;
  try {
    const value = JSON.parse(raw) as Partial<Pending>;
    if (typeof value.base !== 'string' || value.base === '' || typeof value.after !== 'string') return null;
    if (value.token !== null && typeof value.token !== 'string') return null;
    return { base: value.base, token: value.token, after: value.after };
  } catch {
    return null;
  }
}

/** The automatic interval after `failures` failed syncs in a row. */
export function autoInterval(failures: number): number {
  return AUTO_SYNC_MIN_INTERVAL_MS * 2 ** Math.min(failures, MAX_BACKOFF_STEPS);
}

/**
 * Claims the right to sync now: a compare-and-set against the claim read before (`previous`, null when there was
 * none) that also requires it to be at least `minIntervalMs` old. Atomic, one row; false when another request
 * claimed first or the interval has not passed.
 */
export async function claimSync(db: Db, previous: string | null, next: Claim, minIntervalMs: number): Promise<boolean> {
  const result = await db.run(sql`INSERT INTO settings (key, value) VALUES (${KEY_CLAIMED_AT}, ${claimValue(next)})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE settings.value IS ${previous} AND CAST(settings.value AS INTEGER) <= ${next.at - minIntervalMs}`);
  return result.meta.changes === 1;
}

// ---- one chunk of an answer -------------------------------------------------------------------------------------

export interface ChunkPlan {
  /** Task statements of this chunk, in order. */
  taskStatements: SQL[];
  /** Settings writes of this chunk: the token and projects at the end of a pass, or the pending pass. */
  settingStatements: SQL[];
  /** Whether more requests are needed (another chunk of this pass, or a full pass that follows it). */
  partial: boolean;
  /** The project map after this answer (stored at the end of the pass). */
  projects: Map<string, ProjectInfo>;
}

function byId(a: TodoistItem, b: TodoistItem): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * What one Todoist answer changes in this request: the next chunk of the pass. `requested` is the token the answer
 * was asked with, `pending` the pass in progress (null: this answer starts one) and `storedProjects` the stored map.
 */
export function planChunk(
  answer: SyncAnswer,
  requested: string,
  pending: Pending | null,
  storedProjects: ReadonlyMap<string, ProjectInfo>,
  nowIso: string,
): ChunkPlan {
  // A pass in progress continues unless Todoist answered an incremental pass with a full sync: that restarts it.
  const restart = pending === null || pending.token === null || (answer.fullSync && pending.base !== FULL_SYNC_TOKEN);
  const pass: Pending = restart
    ? { base: answer.fullSync ? FULL_SYNC_TOKEN : requested, token: answer.syncToken, after: '' }
    : pending;

  const projects = answer.fullSync ? new Map<string, ProjectInfo>() : new Map(storedProjects);
  const changedProjects: { id: string; name: string; color: string }[] = [];
  const goneProjects = new Set<string>();
  let reappeared = false;
  for (const project of answer.projects) {
    if (project.is_deleted || project.is_archived) {
      projects.delete(project.id);
      goneProjects.add(project.id);
      continue;
    }
    const info = { name: project.name, color: todoistColorToHex(project.color) };
    const before = storedProjects.get(project.id);
    // A project the map does not know, in an incremental answer: new, or unarchived. An unarchived project's tasks
    // may not be listed as changed, so a full pass follows (it writes only what differs).
    if (before === undefined && !answer.fullSync) reappeared = true;
    if (before === undefined || before.name !== info.name || before.color !== info.color) {
      changedProjects.push({ id: project.id, ...info });
    }
    projects.set(project.id, info);
  }

  const isActive = (item: TodoistItem) => !item.checked && !item.is_deleted && !goneProjects.has(item.project_id);
  const remaining = answer.items.filter((item) => item.id > pass.after).sort(byId);
  const chunk = remaining.slice(0, SYNC_CHUNK);
  const last = remaining.length <= SYNC_CHUNK;

  const taskStatements = upsertStatements(chunk.filter(isActive).map((item) => itemToRow(item, projects)), nowIso);
  const gone = chunk.filter((item) => !isActive(item)).map((item) => item.id);
  if (gone.length > 0) taskStatements.push(hideStatement(gone, nowIso));

  const settingStatements: SQL[] = [];
  if (!last) {
    const next: Pending = { ...pass, after: chunk.at(-1)?.id ?? pass.after };
    settingStatements.push(setSettingSql(KEY_PENDING, JSON.stringify(next)));
    return { taskStatements, settingStatements, partial: true, projects };
  }

  if (answer.fullSync) {
    taskStatements.push(orphanStatement(answer.items.filter(isActive).map((item) => item.id), nowIso));
  } else if (changedProjects.length > 0) {
    // Tasks that did not change themselves but whose project was renamed or recoloured.
    taskStatements.push(projectStatement(changedProjects));
  }
  if (goneProjects.size > 0) taskStatements.push(hideProjectsStatement([...goneProjects], nowIso));

  settingStatements.push(setSettingSql(KEY_SYNC_TOKEN, pass.token ?? answer.syncToken), setSettingSql(KEY_PROJECTS, serializeProjects(projects)));
  if (reappeared) {
    settingStatements.push(setSettingSql(KEY_PENDING, JSON.stringify({ base: FULL_SYNC_TOKEN, token: null, after: '' } satisfies Pending)));
  } else {
    settingStatements.push(sql`DELETE FROM settings WHERE key = ${KEY_PENDING}`);
  }
  return { taskStatements, settingStatements, partial: reappeared, projects };
}

// ---- the request -------------------------------------------------------------------------------------------------

export interface SyncRequest {
  db: Db;
  mode: SyncMode;
  /** The Worker secret CREDENTIAL_KEY (64 hex characters) that opens the sealed Todoist key. */
  credentialKey: string | undefined;
  now?: Date;
  fetcher?: typeof fetch;
}

export async function runSync({ db, mode, credentialKey, now = new Date(), fetcher = fetch }: SyncRequest): Promise<SyncOutcome> {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const stored = await getSettings(db, [KEY_API_KEY, KEY_SYNC_TOKEN, KEY_PROJECTS, KEY_CLAIMED_AT, KEY_LAST_SYNC_AT, KEY_PENDING]);
  const sealedKey = stored.get(KEY_API_KEY) ?? null;
  if (sealedKey === null || sealedKey === '') return { kind: 'no_key' };
  const key = await importCredentialKey(credentialKey);
  if (key === null) return { kind: 'not_configured' };
  const apiKey = await openCredential(key, KEY_API_KEY, sealedKey);
  if (apiKey === null) return { kind: 'key_unreadable' };

  // A claim newer than the last successful sync did not finish: count it as a failure.
  const previousRaw = stored.get(KEY_CLAIMED_AT) ?? null;
  const previous = parseClaim(previousRaw);
  const lastSyncMs = Date.parse(stored.get(KEY_LAST_SYNC_AT) ?? '');
  const previousFailed = previous !== null && !(lastSyncMs >= previous.at);
  const failures = previousFailed ? Math.min(previous.failures + 1, 99) : 0;
  const pending = parsePending(stored.get(KEY_PENDING));
  // The next chunk of a pass runs right away, unless the previous request failed.
  const continuing = pending !== null && !previousFailed;
  const autoMs = continuing ? 0 : autoInterval(failures);
  const minInterval = continuing ? 0 : mode === 'manual' ? MANUAL_SYNC_MIN_INTERVAL_MS : autoMs;

  if (!(await claimSync(db, previousRaw, { at: nowMs, failures }, minInterval))) {
    return {
      kind: 'ok',
      response: {
        status: 'throttled',
        changed: 0,
        fullSync: false,
        lastSyncAt: stored.get(KEY_LAST_SYNC_AT) ?? null,
        nextAutoSyncAt: (previous?.at ?? nowMs) + autoMs,
      },
    };
  }

  const storedToken = stored.get(KEY_SYNC_TOKEN) ?? '';
  const requested = pending?.base ?? (storedToken === '' ? FULL_SYNC_TOKEN : storedToken);
  let answer: SyncAnswer;
  try {
    answer = await fetchSync(apiKey, requested, fetcher);
  } catch (error) {
    const failure = (error as { failure?: unknown }).failure;
    return {
      kind: 'todoist',
      failure: failure === 'unauthorized' || failure === 'invalid_answer' || failure === 'too_large' ? failure : 'unavailable',
    };
  }

  const plan = planChunk(answer, requested, pending, parseProjects(stored.get(KEY_PROJECTS) ?? null), nowIso);
  const results = await batchSql(db, [...plan.taskStatements, ...plan.settingStatements, setSettingSql(KEY_LAST_SYNC_AT, nowIso)]);
  const changed = results.slice(0, plan.taskStatements.length).reduce((sum, result) => sum + result.meta.changes, 0);
  return {
    kind: 'ok',
    response: {
      status: plan.partial ? 'partial' : 'synced',
      changed,
      fullSync: answer.fullSync,
      lastSyncAt: nowIso,
      nextAutoSyncAt: plan.partial ? nowMs : nowMs + AUTO_SYNC_MIN_INTERVAL_MS,
    },
  };
}
