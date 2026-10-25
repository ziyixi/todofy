import { create } from '@ziyixi/proto/protobuf';
import { EmptySchema } from '@ziyixi/proto/protobuf/wkt';
import { GoalProgressSchema } from '@ziyixi/proto/tasks/ui/v1/goals_pb';
import {
  ListGoalProgressResponseSchema,
  type ListGoalProgressRequest,
  type CreateGoalProgressRequest,
  type UpdateGoalProgressRequest,
  type DeleteGoalProgressRequest,
} from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { decodePageToken, encodePageToken } from '@ziyixi/proto/page-token';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import { conflict, invalid, missing, storage } from './errors.ts';
import { checkedId } from './model.ts';
import { commit, fingerprint, replay } from './receipts.ts';
import { goalId, progressMessage, type ProgressRow } from './goal-model.ts';
import { checkedGoalUrl, goalPaths } from './goal-validation.ts';

function validate(row: ProgressRow): void {
  checkedId(row.key_result_id);
  if (!row.note || row.note.length > 4000) invalid('A progress note needs 1–4000 characters');
  checkedGoalUrl(row.evidence_url);
}
async function requireResult(db: D1Database, id: string): Promise<void> {
  const row = await storage(() =>
    db.prepare('SELECT id FROM key_results WHERE id=? AND deleted_at IS NULL').bind(id).first(),
  );
  if (!row) missing();
}
async function getProgress(db: D1Database, id: string): Promise<ProgressRow> {
  return (
    (await storage(() =>
      db.prepare('SELECT * FROM goal_progress WHERE id=? AND deleted_at IS NULL').bind(id).first<ProgressRow>(),
    )) ?? missing()
  );
}
function checkEtag(row: ProgressRow, etag: string): void {
  if (!etag) invalid('An etag is required');
  if (String(row.revision) !== etag) conflict();
}
export async function listGoalProgress(db: D1Database, input: ListGoalProgressRequest) {
  const id = checkedId(input.keyResultId);
  if (!Number.isInteger(input.pageSize) || input.pageSize < 0) invalid('Invalid page size');
  const size = Math.min(input.pageSize || 20, 50);
  const parameters = { keyResultId: id };
  const values: (string | number)[] = [id];
  let seek = '';
  if (input.pageToken) {
    let cursor;
    try {
      cursor = decodePageToken(input.pageToken, parameters);
    } catch {
      invalid('Page token does not match this Key Result');
    }
    if (!Array.isArray(cursor) || cursor.length !== 2 || typeof cursor[0] !== 'number' || typeof cursor[1] !== 'string')
      invalid('Invalid progress page token');
    seek = ' AND (created_at,id)<(?,?)';
    values.push(cursor[0], checkedId(cursor[1]));
  }
  // A missing result is distinct from a result whose history is empty.
  await requireResult(db, id);
  const rows = await storage(() =>
    db
      .prepare(
        `SELECT * FROM goal_progress WHERE key_result_id=? AND deleted_at IS NULL${seek}
    ORDER BY created_at DESC,id DESC LIMIT ?`,
      )
      .bind(...values, size + 1)
      .all<ProgressRow>(),
  );
  const page = rows.results.slice(0, size);
  const last = page.at(-1);
  return create(ListGoalProgressResponseSchema, {
    goalProgress: page.map(progressMessage),
    nextPageToken: rows.results.length > size && last ? encodePageToken([last.created_at, last.id], parameters) : '',
  });
}
export async function createGoalProgress(db: D1Database, input: CreateGoalProgressRequest, now: number) {
  const hash = await fingerprint('createGoalProgress', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return fromWire(GoalProgressSchema, JSON.parse(previous)).message;
  if (!input.goalProgress) invalid();
  const row: ProgressRow = {
    id: crypto.randomUUID(),
    key_result_id: input.goalProgress.keyResultId,
    note: input.goalProgress.note.trim(),
    evidence_url: input.goalProgress.evidenceUrl,
    revision: 1,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
  validate(row);
  await requireResult(db, row.key_result_id);
  const response = await commit(
    db,
    {
      requestId: input.requestId,
      hash,
      table: 'goal_progress',
      id: row.id,
      revision: null,
      response: JSON.stringify(toWire(GoalProgressSchema, progressMessage(row))),
      now,
    },
    [
      db
        .prepare(
          'INSERT INTO goal_progress(id,key_result_id,note,evidence_url,created_at,updated_at) VALUES(?,?,?,?,?,?)',
        )
        .bind(row.id, row.key_result_id, row.note, row.evidence_url, now, now),
    ],
  );
  return fromWire(GoalProgressSchema, JSON.parse(response)).message;
}
export async function updateGoalProgress(db: D1Database, input: UpdateGoalProgressRequest, now: number) {
  const hash = await fingerprint('updateGoalProgress', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return fromWire(GoalProgressSchema, JSON.parse(previous)).message;
  if (!input.goalProgress) invalid();
  const old = await getProgress(db, goalId(input.goalProgress.name, 'goalProgress'));
  checkEtag(old, input.etag);
  const paths = goalPaths(input.updateMask, ['note', 'evidence_url', 'key_result_id']);
  if (
    (paths.includes('key_result_id') || input.goalProgress.keyResultId) &&
    input.goalProgress.keyResultId !== old.key_result_id
  )
    invalid('A progress note cannot move to another Key Result');
  const row = {
    ...old,
    ...(paths.includes('note') ? { note: input.goalProgress.note.trim() } : {}),
    ...(paths.includes('evidence_url') ? { evidence_url: input.goalProgress.evidenceUrl } : {}),
    revision: old.revision + 1,
    updated_at: now,
  };
  validate(row);
  const response = await commit(
    db,
    {
      requestId: input.requestId,
      hash,
      table: 'goal_progress',
      id: row.id,
      revision: old.revision,
      response: JSON.stringify(toWire(GoalProgressSchema, progressMessage(row))),
      now,
    },
    [
      db
        .prepare('UPDATE goal_progress SET note=?,evidence_url=?,revision=revision+1,updated_at=? WHERE id=?')
        .bind(row.note, row.evidence_url, now, row.id),
    ],
  );
  return fromWire(GoalProgressSchema, JSON.parse(response)).message;
}
export async function deleteGoalProgress(db: D1Database, input: DeleteGoalProgressRequest, now: number) {
  const hash = await fingerprint('deleteGoalProgress', input);
  if ((await replay(db, input.requestId, hash)) !== null) return create(EmptySchema);
  const old = await getProgress(db, goalId(input.name, 'goalProgress'));
  checkEtag(old, input.etag);
  await commit(
    db,
    {
      requestId: input.requestId,
      hash,
      table: 'goal_progress',
      id: old.id,
      revision: old.revision,
      response: '{}',
      now,
    },
    [
      db
        .prepare('UPDATE goal_progress SET deleted_at=?,updated_at=?,revision=revision+1 WHERE id=?')
        .bind(now, now, old.id),
    ],
  );
  return create(EmptySchema);
}
