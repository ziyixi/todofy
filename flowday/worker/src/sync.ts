/**
 * POST /api/sync: bring Todoist's changes into D1 with as few D1 row writes as possible (../../docs/design.md
 * "Todoist sync" and "Write budget"). FlowDay only reads Todoist (./todoist.ts).
 *
 * 1. One read of the settings (token, sync token, projects, claim, last sync).
 * 2. Atomic throttle: an upsert of `sync_claimed_at` that only succeeds when the previous claim is older than the
 *    minimum interval (5 minutes for the automatic sync, 30 seconds for "Sync now"). Concurrent tabs or devices
 *    cannot both win, so at most one Todoist read and one write batch happen per interval. 1 row written.
 * 3. One Todoist Sync API read with the stored sync token: only what changed since the last sync.
 * 4. One atomic D1 batch: diff upserts of the changed active items, hiding of completed or deleted ones (after a
 *    full sync: of every task Todoist no longer lists), renamed projects, the new sync token and projects (only
 *    when they changed) and last_sync_at. A sync with no Todoist change writes 2 rows (claim, last_sync_at).
 */
import type { SyncResponse } from './api-types.ts';
import { batchSql, type Db } from './db.ts';
import { getSettings, setSettingSql } from './store/settings.ts';
import { hideStatement, orphanStatement, projectStatement, upsertStatements } from './store/tasks.ts';
import { FULL_SYNC_TOKEN, fetchSync, itemToRow, todoistColorToHex, type ProjectInfo, type SyncAnswer } from './todoist.ts';
import { sql } from 'drizzle-orm';

export const AUTO_SYNC_MIN_INTERVAL_MS = 5 * 60_000;
export const MANUAL_SYNC_MIN_INTERVAL_MS = 30_000;

export const KEY_API_KEY = 'todoist_api_key';
export const KEY_SYNC_TOKEN = 'todoist_sync_token';
export const KEY_PROJECTS = 'todoist_projects';
export const KEY_CLAIMED_AT = 'sync_claimed_at';
export const KEY_LAST_SYNC_AT = 'last_sync_at';

export type SyncMode = 'auto' | 'manual';

export type SyncOutcome =
  | { kind: 'ok'; response: SyncResponse }
  | { kind: 'no_key' }
  | { kind: 'todoist'; failure: 'unauthorized' | 'unavailable' | 'invalid_answer' | 'too_large' };

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

/** Claims the right to sync now; false when another sync ran within `minIntervalMs`. Atomic, one row. */
export async function claimSync(db: Db, nowMs: number, minIntervalMs: number): Promise<boolean> {
  const result = await db.run(sql`INSERT INTO settings (key, value) VALUES (${KEY_CLAIMED_AT}, ${String(nowMs)})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE CAST(settings.value AS INTEGER) <= ${nowMs - minIntervalMs}`);
  return result.meta.changes === 1;
}

/** What one Todoist answer changes: statements for the batch (task statements first). */
export function planSync(answer: SyncAnswer, stored: ReadonlyMap<string, ProjectInfo>, nowIso: string) {
  const projects = answer.fullSync ? new Map<string, ProjectInfo>() : new Map(stored);
  const changedProjects: { id: string; name: string; color: string }[] = [];
  for (const project of answer.projects) {
    if (project.is_deleted) {
      projects.delete(project.id);
      continue;
    }
    const info = { name: project.name, color: todoistColorToHex(project.color) };
    const before = stored.get(project.id);
    if (before === undefined || before.name !== info.name || before.color !== info.color) {
      changedProjects.push({ id: project.id, ...info });
    }
    projects.set(project.id, info);
  }
  const active = answer.items.filter((item) => !item.checked && !item.is_deleted);
  const gone = answer.items.filter((item) => item.checked || item.is_deleted).map((item) => item.id);
  const taskStatements = upsertStatements(active.map((item) => itemToRow(item, projects)), nowIso);
  if (answer.fullSync) {
    taskStatements.push(orphanStatement(active.map((item) => item.id), nowIso));
  } else {
    if (gone.length > 0) taskStatements.push(hideStatement(gone, nowIso));
    // Tasks that did not change themselves but whose project was renamed or recoloured.
    if (changedProjects.length > 0) taskStatements.push(projectStatement(changedProjects));
  }
  return { taskStatements, projects };
}

export async function runSync(
  db: Db,
  mode: SyncMode,
  now: Date = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<SyncOutcome> {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const stored = await getSettings(db, [KEY_API_KEY, KEY_SYNC_TOKEN, KEY_PROJECTS, KEY_CLAIMED_AT, KEY_LAST_SYNC_AT]);
  const apiKey = stored.get(KEY_API_KEY) ?? null;
  if (apiKey === null || apiKey === '') return { kind: 'no_key' };

  const minInterval = mode === 'manual' ? MANUAL_SYNC_MIN_INTERVAL_MS : AUTO_SYNC_MIN_INTERVAL_MS;
  if (!(await claimSync(db, nowMs, minInterval))) {
    const claimedAt = Number(stored.get(KEY_CLAIMED_AT) ?? '0');
    return {
      kind: 'ok',
      response: {
        status: 'throttled',
        changed: 0,
        fullSync: false,
        lastSyncAt: stored.get(KEY_LAST_SYNC_AT) ?? null,
        nextAutoSyncAt: (Number.isFinite(claimedAt) ? claimedAt : nowMs) + AUTO_SYNC_MIN_INTERVAL_MS,
      },
    };
  }

  const syncToken = stored.get(KEY_SYNC_TOKEN) ?? FULL_SYNC_TOKEN;
  let answer: SyncAnswer;
  try {
    answer = await fetchSync(apiKey, syncToken === '' ? FULL_SYNC_TOKEN : syncToken, fetcher);
  } catch (error) {
    const failure = (error as { failure?: unknown }).failure;
    return {
      kind: 'todoist',
      failure: failure === 'unauthorized' || failure === 'invalid_answer' || failure === 'too_large' ? failure : 'unavailable',
    };
  }

  const storedProjects = parseProjects(stored.get(KEY_PROJECTS) ?? null);
  const { taskStatements, projects } = planSync(answer, storedProjects, nowIso);
  const results = await batchSql(db, [
    ...taskStatements,
    setSettingSql(KEY_SYNC_TOKEN, answer.syncToken),
    setSettingSql(KEY_PROJECTS, serializeProjects(projects)),
    setSettingSql(KEY_LAST_SYNC_AT, nowIso),
  ]);
  const changed = results.slice(0, taskStatements.length).reduce((sum, result) => sum + result.meta.changes, 0);
  return {
    kind: 'ok',
    response: { status: 'synced', changed, fullSync: answer.fullSync, lastSyncAt: nowIso, nextAutoSyncAt: nowMs + AUTO_SYNC_MIN_INTERVAL_MS },
  };
}
