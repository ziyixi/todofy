import { create } from '@ziyixi/proto/protobuf';
import { LaneOrderSchema } from '@ziyixi/proto/tasks/ui/v1/plan_pb';
import { ReorderTasksResponseSchema, type ReorderTasksRequest } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { localDate } from '@ziyixi/task-dates';
import { conflict, invalid, storage } from './errors.ts';
import { commitChecked, type Check } from './focus.ts';
import {
  checkedId,
  childCounts,
  dependencyList,
  resourceId,
  taskMessage,
  taskProjection,
  type TaskRow,
} from './model.ts';
import { arrangeLane, LANES, MAX_LANE_TASKS, type Lanes } from './planning.ts';
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

/**
 * Dedicated sort-order writes share one receipt and one all-row CAS guard. With a lane order, the Review board is
 * saved in the same batch over the revision it was read at. The answer reads the repositioned tasks and the lane
 * again, also for a replay.
 */
export async function reorderTasks(db: D1Database, input: ReorderTasksRequest, now: number, zone: string) {
  const hash = await fingerprint('reorderTasks', input);
  const previous = await replay(db, input.requestId, hash);
  const lane = input.laneOrder;
  if (lane && (!(LANES as readonly string[]).includes(lane.lane) || lane.taskIds.length > MAX_LANE_TASKS))
    invalid(`Order one Review lane of at most ${String(MAX_LANE_TASKS)} tasks`);
  if (input.positions.length > 100 || (!input.positions.length && !lane)) invalid('Provide 1–100 task positions');
  const positions: Position[] = input.positions.map((position) => {
    if (!position.etag || !Number.isFinite(position.sortOrder)) invalid('Each task needs an etag and finite position');
    return {
      id: resourceId(position.name, 'tasks'),
      etag: position.etag,
      sort_order: position.sortOrder,
    };
  });
  if (new Set(positions.map((position) => position.id)).size !== positions.length) invalid('Task names must be unique');
  const laneIds = lane ? lane.taskIds.map(checkedId) : [];
  const encoded = JSON.stringify(positions);
  if (previous === null) await write(db, input, hash, positions, lane && { lane: lane.lane, ids: laneIds }, now);
  const [tasks, board] = await storage(() =>
    db.batch<Record<string, unknown>>([
      db
        .prepare(
          `SELECT ${taskProjection(false)},${childCounts},${dependencyList} FROM json_each(?) j CROSS JOIN tasks t
          ON t.id=j.value->>'id' WHERE t.deleted_at IS NULL ORDER BY j.key`,
        )
        .bind(encoded),
      db.prepare("SELECT lanes FROM plan_board WHERE id='board'"),
    ]),
  );
  const today = localDate(now, zone);
  const lanes = JSON.parse((board?.results[0] as { lanes?: string } | undefined)?.lanes ?? '{}') as Lanes;
  return create(ReorderTasksResponseSchema, {
    tasks: ((tasks?.results ?? []) as unknown as TaskRow[]).map((row) => {
      const task = taskMessage(row, today);
      task.description = '';
      return task;
    }),
    ...(lane ? { laneOrder: create(LaneOrderSchema, { lane: lane.lane, taskIds: lanes[lane.lane] ?? [] }) } : {}),
  });
}

async function write(
  db: D1Database,
  input: ReorderTasksRequest,
  hash: Awaited<ReturnType<typeof fingerprint>>,
  positions: Position[],
  lane: { lane: string; ids: string[] } | undefined,
  now: number,
): Promise<void> {
  const encoded = JSON.stringify(positions);
  if (positions.length) await checkCurrent(db, encoded, positions.length);
  const writes: D1PreparedStatement[] = [];
  const checks: Check[] = [];
  let board: { lanes: string; revision: number } | null = null;
  if (lane) {
    board = await storage(() =>
      db.prepare("SELECT lanes,revision FROM plan_board WHERE id='board'").first<{ lanes: string; revision: number }>(),
    );
    if (!board) throw new Error('The Review board row is missing');
    writes.push(
      db
        .prepare("UPDATE plan_board SET lanes=?,revision=revision+1,updated_at=? WHERE id='board'")
        .bind(JSON.stringify(arrangeLane(JSON.parse(board.lanes) as Lanes, lane.lane, lane.ids)), now),
    );
  }
  const first = positions[0];
  if (first) {
    writes.unshift(
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
    );
    if (board)
      checks.push({
        sql: "(SELECT revision FROM plan_board WHERE id='board')=?",
        values: [board.revision],
        message: 'The Review board changed. Refresh and try again.',
      });
  }
  const receipt = {
    requestId: input.requestId,
    hash,
    response: '{}',
    now,
    ...(first
      ? { table: 'tasks' as const, id: first.id, revision: Number(first.etag) }
      : { table: 'plan_board' as const, id: 'board', revision: board?.revision ?? 0 }),
  };
  try {
    await (checks.length ? commitChecked(db, receipt, writes, checks) : commit(db, receipt, writes));
  } catch (error) {
    // commit checks its first resource; this operation also guards every other task in the same transaction.
    if (positions.length) await checkCurrent(db, encoded, positions.length);
    throw error;
  }
}
