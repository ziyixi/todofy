import { updatePaths } from '@ziyixi/proto/field-mask';
import { invalid, precondition, storage } from './errors.ts';
import { checkedId } from './model.ts';
import type { Check } from './focus.ts';
import type { KeyResultRow, ObjectiveRow } from './goal-model.ts';
import { checkedYear } from './goal-read.ts';

export function goalPaths(mask: { paths: string[] } | undefined, allowed: readonly string[]): readonly string[] {
  if (!mask?.paths.length) invalid('An explicit update_mask is required');
  const paths = updatePaths(mask);
  if (paths === '*' || paths.some((path) => !allowed.includes(path))) invalid('Unsupported goal update field');
  return paths;
}
export function checkedGoalUrl(value: string): string {
  if (value.length > 2000) invalid('A goal URL is too long');
  if (!value) return '';
  try {
    if (!['http:', 'https:'].includes(new URL(value).protocol)) invalid('A goal URL must use HTTP or HTTPS');
  } catch {
    invalid('A goal URL must use HTTP or HTTPS');
  }
  return value;
}
export function validateObjective(row: ObjectiveRow): void {
  checkedYear(row.year);
  if (!row.title || row.title.length > 300 || row.description.length > 2000 || !Number.isFinite(row.sort_order))
    invalid();
  checkedGoalUrl(row.source_url);
}
export function validateKeyResult(row: KeyResultRow): void {
  checkedId(row.objective_id);
  if (
    !row.title ||
    row.title.length > 300 ||
    row.floor_text.length > 2000 ||
    row.target_text.length > 2000 ||
    row.notes.length > 8000 ||
    row.focus_text.length > 1000 ||
    !Number.isFinite(row.sort_order) ||
    !['outcome', 'routine', 'exploration'].includes(row.kind)
  )
    invalid();
  const month = new RegExp(`^${String(row.year)}-(0[1-9]|1[0-2])$`);
  if (row.focus_start_month || row.focus_end_month) {
    if (
      !month.test(row.focus_start_month) ||
      !month.test(row.focus_end_month) ||
      row.focus_start_month > row.focus_end_month
    )
      invalid('Focus needs an ordered month range within the Key Result year');
  } else if (row.focus_text) invalid('Focus text needs its month range');
  checkedGoalUrl(row.source_url);
}

/** Selectability is checked only for a new or changed link, so archived links survive ordinary task edits. */
export function selectableKeyResult(id: string): Check {
  checkedId(id);
  return {
    sql: `EXISTS(SELECT 1 FROM key_results k JOIN objectives o ON o.id=k.objective_id
      WHERE k.id=? AND k.deleted_at IS NULL AND o.deleted_at IS NULL AND k.archived=0 AND o.archived=0)`,
    values: [id],
    message: 'Choose an active Key Result',
  };
}
export async function validateKeyResultLink(db: D1Database, id: string): Promise<string> {
  checkedId(id);
  const row = await storage(() =>
    db
      .prepare(
        `SELECT k.title FROM key_results k JOIN objectives o ON o.id=k.objective_id
    WHERE k.id=? AND k.deleted_at IS NULL AND o.deleted_at IS NULL AND k.archived=0 AND o.archived=0`,
      )
      .bind(id)
      .first<{ title: string }>(),
  );
  if (!row) precondition('Choose an active Key Result');
  return row.title;
}
