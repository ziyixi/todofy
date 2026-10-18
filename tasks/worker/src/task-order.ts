import { create } from '@ziyixi/proto/protobuf';
import { ReorderTasksResponseSchema, type ReorderTasksRequest } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { conflict, invalid, storage } from './errors.ts';
import { resourceId } from './model.ts';
import { commit, fingerprint, replay } from './receipts.ts';

interface Position {
  id: string;
  etag: string;
  sort_order: number;
}
const matching = `FROM json_each(?) j JOIN tasks t ON t.id=j.value->>'id'
  WHERE CAST(t.revision AS TEXT)=j.value->>'etag' AND t.deleted_at IS NULL
    AND t.completed=0 AND t.project_archived=0`;

async function checkCurrent(db: D1Database, positions: string, count: number): Promise<void> {
  const row = await storage(() =>
    db.prepare(`SELECT count(*) AS n ${matching}`).bind(positions).first<{ n: number }>(),
  );
  if (row?.n !== count) conflict();
}

/** Dedicated sort-order writes share one receipt and one all-row CAS guard. */
export async function reorderTasks(db: D1Database, input: ReorderTasksRequest, now: number) {
  const hash = await fingerprint('reorderTasks', input);
  const previous = await replay(db, input.requestId, hash);
  if (previous !== null) return create(ReorderTasksResponseSchema);
  if (!input.positions.length || input.positions.length > 100) invalid('Provide 1–100 task positions');
  const positions: Position[] = input.positions.map((position) => {
    if (!position.etag || !Number.isFinite(position.sortOrder))
      invalid('Each task needs an etag and finite position');
    return {
      id: resourceId(position.name, 'tasks'),
      etag: position.etag,
      sort_order: position.sortOrder,
    };
  });
  if (new Set(positions.map((position) => position.id)).size !== positions.length)
    invalid('Task names must be unique');
  const first = positions[0];
  if (!first) invalid();
  const encoded = JSON.stringify(positions);
  await checkCurrent(db, encoded, positions.length);
  try {
    await commit(
      db,
      {
        requestId: input.requestId,
        hash,
        table: 'tasks',
        id: first.id,
        revision: Number(first.etag),
        response: '{}',
        now,
      },
      [
        db
          .prepare(
            `UPDATE requests SET revision_guard=CASE WHEN (SELECT count(*) ${matching})=? THEN 1 ELSE 0 END WHERE id=?`,
          )
          .bind(encoded, positions.length, input.requestId),
        db
          .prepare(
            `UPDATE tasks SET sort_order=j.value->>'sort_order',revision=tasks.revision+1,updated_at=?
        FROM json_each(?) j WHERE tasks.id=j.value->>'id' AND tasks.sort_order<>j.value->>'sort_order'`,
          )
          .bind(now, encoded),
      ],
    );
  } catch (error) {
    // commit checks its first resource; this operation also guards every other task in the same transaction.
    await checkCurrent(db, encoded, positions.length);
    throw error;
  }
  return create(ReorderTasksResponseSchema);
}
