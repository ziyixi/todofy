import { create } from '@ziyixi/proto/protobuf';
import { GoalCatalogSchema } from '@ziyixi/proto/tasks/ui/v1/goals_pb';
import type { GetGoalCatalogRequest } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { localDate } from '@ziyixi/task-dates';
import { invalid, missing, precondition, storage } from './errors.ts';
import { checkedId } from './model.ts';
import {
  KEY_RESULT_LIMIT,
  OBJECTIVE_LIMIT,
  keyResultSummary,
  objectiveMessage,
  type KeyResultRow,
  type ObjectiveRow,
} from './goal-model.ts';

export function checkedYear(year: number): number {
  if (!Number.isInteger(year) || year < 2000 || year > 2199) invalid('Choose a calendar year from 2000 through 2199');
  return year;
}
export async function getObjective(db: D1Database, id: string): Promise<ObjectiveRow> {
  const row = await storage(() =>
    db.prepare('SELECT * FROM objectives WHERE id=? AND deleted_at IS NULL').bind(checkedId(id)).first<ObjectiveRow>(),
  );
  return row ?? missing();
}
export async function getKeyResult(db: D1Database, id: string): Promise<KeyResultRow> {
  const row = await storage(() =>
    db
      .prepare(
        `SELECT k.*,o.year,o.archived AS objective_archived FROM key_results k JOIN objectives o ON o.id=k.objective_id
      WHERE k.id=? AND k.deleted_at IS NULL AND o.deleted_at IS NULL`,
      )
      .bind(checkedId(id))
      .first<KeyResultRow>(),
  );
  return row ?? missing();
}
export async function getGoalCatalog(db: D1Database, input: GetGoalCatalogRequest, zone: string, now: number) {
  if (input.name !== 'goalCatalog') invalid('The goal catalog is named goalCatalog');
  const today = localDate(now, zone);
  const year = checkedYear(input.year || Number(today.slice(0, 4)));
  const [objectives, results] = await storage(() =>
    db.batch([
      db
        .prepare(
          `SELECT * FROM objectives WHERE year=? AND deleted_at IS NULL ORDER BY sort_order,id LIMIT ${String(OBJECTIVE_LIMIT + 1)}`,
        )
        .bind(year),
      // Read concise definitions, never notes, milestone text or annual progress history.
      db
        .prepare(
          `SELECT k.id,k.objective_id,o.year,o.archived AS objective_archived,k.title,k.kind,k.completed,
      json_array_length(k.milestones) AS milestone_count,
      (SELECT count(*) FROM json_each(k.milestones) m WHERE m.value->>'completed'=1) AS completed_milestone_count,
      k.focus_start_month,k.focus_end_month,k.focus_text,k.source_url,k.sort_order,k.archived,k.revision,k.created_at,k.updated_at
      FROM objectives o CROSS JOIN key_results k INDEXED BY key_results_objective ON k.objective_id=o.id
      WHERE o.year=? AND o.deleted_at IS NULL AND k.deleted_at IS NULL ORDER BY k.sort_order,k.id LIMIT ${String(KEY_RESULT_LIMIT + 1)}`,
        )
        .bind(year),
    ]),
  );
  if ((objectives?.results.length ?? 0) > OBJECTIVE_LIMIT || (results?.results.length ?? 0) > KEY_RESULT_LIMIT)
    precondition('Annual goals exceed the personal catalog limit');
  return create(GoalCatalogSchema, {
    name: 'goalCatalog',
    year,
    today,
    timeZone: zone,
    objectives: (objectives?.results as unknown as ObjectiveRow[]).map(objectiveMessage),
    keyResults: (results?.results as unknown as KeyResultRow[]).map(keyResultSummary),
  });
}
