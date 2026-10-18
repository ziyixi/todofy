/**
 * The one-time copy of FlowDay's estimate overrides into Tasks (2026-10-18, docs/backup.md).
 *
 * Until then FlowDay kept its own estimate for a mirrored task once the owner set one there (`estimate_override`),
 * and Plan showed that value. Since then a task's estimate is its Tasks duration alone. For each override whose
 * Tasks task exists and differs, this writes FlowDay's value, the one the owner saw, into Tasks with Tasks' own
 * write semantics: `revision+1`, `updated_at` in milliseconds, and the change row the `tasks_update` trigger
 * appends, so FlowDay's mirror learns the value at its next sync. Each statement only applies to the exported
 * revision, so a task edited since the export is left alone and the next dry run counts it again.
 *
 * The inputs are `wrangler d1 execute --json` answers of two read-only queries; nothing here reads task text.
 */
export class EstimateBackfillError extends Error {}

export interface EstimateUpdate {
  id: string;
  minutes: number;
  revision: number;
}
export interface EstimateBackfill {
  updates: EstimateUpdate[];
  /** The `updated_at` every statement writes, in milliseconds. */
  now: number;
  overrides: number;
  unchanged: number;
  skipped: { missing: number; invalidValue: number; invalidId: number };
}

const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Tasks' own bound on a duration (worker/src/task-validation.ts). */
const MAX_MINUTES = 10080;

/** The rows of a `wrangler d1 execute --json` answer: `[{results: [...]}, ...]`. */
function resultRows(answer: unknown, code: string): Record<string, unknown>[] {
  if (!Array.isArray(answer)) throw new EstimateBackfillError(code);
  return answer.flatMap((statement: unknown) => {
    const results = (statement as { results?: unknown } | null)?.results;
    if (!Array.isArray(results)) throw new EstimateBackfillError(code);
    return results.map((row: unknown) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new EstimateBackfillError(code);
      return row as Record<string, unknown>;
    });
  });
}

function minutesOf(value: unknown): number | undefined {
  // FlowDay's NULL is no estimate, which Tasks writes as 0.
  const result = value ?? 0;
  return typeof result === 'number' && Number.isInteger(result) && result >= 0 && result <= MAX_MINUTES
    ? result
    : undefined;
}

/** Live Tasks rows by id: `SELECT id, duration_minutes, revision FROM tasks WHERE deleted_at IS NULL`. */
function tasksById(answer: unknown): Map<string, { duration: number; revision: number }> {
  const byId = new Map<string, { duration: number; revision: number }>();
  for (const row of resultRows(answer, 'TASKS_EXPORT_INVALID')) {
    const { id, duration_minutes: duration, revision } = row;
    if (
      typeof id !== 'string' ||
      byId.has(id) ||
      typeof duration !== 'number' ||
      !Number.isInteger(duration) ||
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision < 1
    )
      throw new EstimateBackfillError('TASKS_EXPORT_INVALID');
    byId.set(id, { duration, revision });
  }
  return byId;
}

/**
 * `flowdayExport`: `SELECT id, estimated_mins FROM tasks WHERE estimate_override=1 AND todoist_id IS NOT NULL` on
 * FlowDay's D1. `tasksExport`: the live Tasks rows above. `now`: the `updated_at` to write, in milliseconds.
 */
export function prepareEstimateBackfill(flowdayExport: unknown, tasksExport: unknown, now: number): EstimateBackfill {
  if (!Number.isSafeInteger(now) || now <= 0) throw new EstimateBackfillError('NOW_INVALID');
  const tasks = tasksById(tasksExport);
  const overrides = resultRows(flowdayExport, 'FLOWDAY_EXPORT_INVALID');
  const plan: EstimateBackfill = {
    updates: [],
    now,
    overrides: overrides.length,
    unchanged: 0,
    skipped: { missing: 0, invalidValue: 0, invalidId: 0 },
  };
  const seen = new Set<string>();
  for (const row of overrides) {
    const id = row.id;
    if (typeof id !== 'string' || !ID.test(id)) {
      plan.skipped.invalidId++;
      continue;
    }
    if (seen.has(id)) throw new EstimateBackfillError('FLOWDAY_EXPORT_INVALID');
    seen.add(id);
    const value = minutesOf(row.estimated_mins);
    if (value === undefined) {
      plan.skipped.invalidValue++;
      continue;
    }
    const task = tasks.get(id);
    if (!task) plan.skipped.missing++;
    else if (task.duration === value) plan.unchanged++;
    else plan.updates.push({ id, minutes: value, revision: task.revision });
  }
  plan.updates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return plan;
}

/** One guarded UPDATE per task, for `wrangler d1 execute --file`. Only checked ids are quoted into the SQL. */
export function estimateBackfillSql(plan: EstimateBackfill): string {
  if (!plan.updates.length) return 'SELECT 0 AS updated_count;\n';
  if (plan.updates.some((update) => !ID.test(update.id))) throw new EstimateBackfillError('PLAN_INVALID');
  return plan.updates
    .map(
      ({ id, minutes, revision }) =>
        `UPDATE tasks SET duration_minutes=${String(minutes)},revision=revision+1,updated_at=${String(plan.now)} ` +
        `WHERE id='${id}' AND revision=${String(revision)} AND deleted_at IS NULL;\n`,
    )
    .join('');
}
