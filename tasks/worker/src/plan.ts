/**
 * Plan (proto/tasks/ui/v1/plan.proto). GetPlan reads the week's Bets, the arranged Review lanes and next week's
 * choices in one batch of three primary-key or indexed reads. UpdateWeeklyBet writes one Bet by compare-and-set: a
 * value write without a receipt, so sending the saved text again answers it as saved.
 */
import { updatePaths } from '@ziyixi/proto/field-mask';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import {
  LaneOrderSchema,
  PlanSchema,
  WeeklyBetSchema,
  type LaneOrder,
  type WeeklyBet,
} from '@ziyixi/proto/tasks/ui/v1/plan_pb';
import type { GetPlanRequest, UpdateWeeklyBetRequest } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { localDate, validDate } from '@ziyixi/task-dates';
import { conflict, invalid, precondition, storage } from './errors.ts';
import { selectableKeyResult, validateKeyResultLink } from './goal-validation.ts';
import { BET_AREAS, betText, betWeeks, betWritable, LANES, mondayOf, type Lanes } from './planning.ts';

/** The most next-week choices a plan lists. */
const NEXT_WEEK_TASKS = 100;

interface BetRow {
  week_start: string;
  area: string;
  text: string;
  key_result_id: string;
  key_result_title?: string;
  revision: number;
  updated_at: number;
}
function betMessage(row: BetRow): WeeklyBet {
  return create(WeeklyBetSchema, {
    name: `weeklyBets/${row.week_start}-${row.area}`,
    weekStart: row.week_start,
    area: row.area,
    text: row.text,
    keyResultId: row.key_result_id,
    keyResultTitle: row.key_result_title ?? '',
    etag: String(row.revision),
    updateTime: timestampFromMs(row.updated_at),
  });
}
/** The board's lanes in board order. */
export function laneOrders(lanes: Lanes): LaneOrder[] {
  return LANES.flatMap((lane) => {
    const taskIds = lanes[lane] ?? [];
    return taskIds.length ? [create(LaneOrderSchema, { lane, taskIds })] : [];
  });
}

export async function getPlan(db: D1Database, input: GetPlanRequest, zone: string, now: number) {
  if (input.name !== 'plan') invalid('The plan is named plan');
  const today = localDate(now, zone);
  const week = mondayOf(today);
  const [bets, board, chosen] = await storage(() =>
    db.batch<Record<string, unknown>>([
      db
        .prepare(
          `SELECT b.*,k.title AS key_result_title FROM weekly_bets b LEFT JOIN key_results k
          ON k.id=b.key_result_id AND k.deleted_at IS NULL WHERE b.week_start IN (?,?,?)`,
        )
        .bind(...betWeeks(week)),
      db.prepare("SELECT lanes FROM plan_board WHERE id='board'"),
      // D1 never runs ANALYZE, and without statistics SQLite prefers tasks_deadline here: name the partial index,
      // whose WHERE terms the query repeats.
      db
        .prepare(
          `SELECT id FROM tasks INDEXED BY tasks_committed WHERE stage='committed' AND deleted_at IS NULL
          AND committed_week>? AND completed=0 ORDER BY committed_week LIMIT ${String(NEXT_WEEK_TASKS)}`,
        )
        .bind(week),
    ]),
  );
  const betRows = (bets?.results ?? []) as unknown as BetRow[];
  betRows.sort(
    (left, right) =>
      left.week_start.localeCompare(right.week_start) ||
      BET_AREAS.indexOf(left.area as never) - BET_AREAS.indexOf(right.area as never),
  );
  const lanes = JSON.parse((board?.results[0] as { lanes?: string } | undefined)?.lanes ?? '{}') as Lanes;
  return create(PlanSchema, {
    name: 'plan',
    timeZone: zone,
    today,
    weekStart: week,
    weeklyBets: betRows.map(betMessage),
    laneOrders: laneOrders(lanes),
    nextWeekTaskIds: (chosen?.results ?? []).map((row) => String(row.id)),
  });
}

export async function updateWeeklyBet(db: D1Database, input: UpdateWeeklyBetRequest, zone: string, now: number) {
  const bet = input.weeklyBet;
  if (!bet) invalid();
  const paths = input.updateMask?.paths.length ? updatePaths(input.updateMask) : ['text'];
  if (paths === '*' || paths.some((path) => path !== 'text' && path !== 'key_result_id'))
    invalid('Only Bet text and Key Result change');
  const name = /^weeklyBets\/(\d{4}-\d\d-\d\d)-(work|personal)$/.exec(bet.name);
  const week = name?.[1] ?? '';
  const area = name?.[2] ?? '';
  if (!validDate(week) || mondayOf(week) !== week) invalid('A goal is named weeklyBets/{monday}-{work|personal}');
  const saved = await storage(() =>
    db
      .prepare(
        `SELECT b.*,k.title AS key_result_title FROM weekly_bets b LEFT JOIN key_results k
        ON k.id=b.key_result_id AND k.deleted_at IS NULL WHERE b.week_start=? AND b.area=?`,
      )
      .bind(week, area)
      .first<BetRow>(),
  );
  const current = saved
    ? betMessage(saved)
    : create(WeeklyBetSchema, {
        name: bet.name,
        weekStart: week,
        area,
        text: '',
        etag: '',
      });
  const text = paths.includes('text') ? betText(bet.text) : current.text;
  const keyResultId = paths.includes('key_result_id') ? bet.keyResultId : current.keyResultId;
  // A replay compares the values this write owns, and preserves whatever an unmasked field now contains.
  if (current.text === text && current.keyResultId === keyResultId) return current;
  if (!betWritable(week, mondayOf(localDate(now, zone))))
    precondition("Only this week's and next week's goals can be changed");
  if (input.etag !== current.etag) conflict();
  const changedLink = keyResultId && keyResultId !== current.keyResultId;
  const title = changedLink ? await validateKeyResultLink(db, keyResultId) : current.keyResultTitle;
  const check = changedLink ? selectableKeyResult(keyResultId) : null;
  const written = await storage(() =>
    db
      .prepare(
        `INSERT INTO weekly_bets(week_start,area,text,revision,created_at,updated_at,key_result_id)
        SELECT ?,?,?,1,?,?,? WHERE ${check?.sql ?? '1'}
        ON CONFLICT(week_start,area) DO UPDATE SET text=excluded.text,key_result_id=excluded.key_result_id,revision=weekly_bets.revision+1,
          updated_at=excluded.updated_at WHERE weekly_bets.revision=?
        RETURNING week_start,area,text,key_result_id,revision,updated_at`,
      )
      .bind(week, area, text, now, now, keyResultId, ...(check?.values ?? []), saved?.revision ?? 0)
      .first<BetRow>(),
  );
  // Saved by someone else since it was read.
  if (!written) {
    if (changedLink) await validateKeyResultLink(db, keyResultId);
    conflict();
  }
  return betMessage({ ...written, key_result_title: keyResultId ? title : '' });
}
