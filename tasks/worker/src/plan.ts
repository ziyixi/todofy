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
import { BET_AREAS, betText, betWeeks, betWritable, LANES, mondayOf, type Lanes } from './planning.ts';

/** The most next-week choices a plan lists. */
const NEXT_WEEK_TASKS = 100;

interface BetRow {
  week_start: string;
  area: string;
  text: string;
  revision: number;
  updated_at: number;
}
function betMessage(row: BetRow): WeeklyBet {
  return create(WeeklyBetSchema, {
    name: `weeklyBets/${row.week_start}-${row.area}`,
    weekStart: row.week_start,
    area: row.area,
    text: row.text,
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
        .prepare('SELECT week_start,area,text,revision,updated_at FROM weekly_bets WHERE week_start IN (?,?,?)')
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
  if (paths === '*' || paths.some((path) => path !== 'text')) invalid("Only a goal's text changes");
  const name = /^weeklyBets\/(\d{4}-\d\d-\d\d)-(work|personal)$/.exec(bet.name);
  const week = name?.[1] ?? '';
  const area = name?.[2] ?? '';
  if (!validDate(week) || mondayOf(week) !== week) invalid('A goal is named weeklyBets/{monday}-{work|personal}');
  const text = betText(bet.text);
  const saved = await storage(() =>
    db
      .prepare('SELECT week_start,area,text,revision,updated_at FROM weekly_bets WHERE week_start=? AND area=?')
      .bind(week, area)
      .first<BetRow>(),
  );
  const current = saved
    ? betMessage(saved)
    : create(WeeklyBetSchema, { name: bet.name, weekStart: week, area, text: '', etag: '' });
  // The saved text answers as saved, whatever the etag and the day: a replay after a lost answer.
  if (current.text === text) return current;
  if (!betWritable(week, mondayOf(localDate(now, zone))))
    precondition("Only this week's and next week's goals can be changed");
  if (bet.etag !== current.etag) conflict();
  const written = await storage(() =>
    db
      .prepare(
        `INSERT INTO weekly_bets(week_start,area,text,revision,created_at,updated_at) VALUES(?,?,?,1,?,?)
        ON CONFLICT(week_start,area) DO UPDATE SET text=excluded.text,revision=weekly_bets.revision+1,
          updated_at=excluded.updated_at WHERE weekly_bets.revision=?
        RETURNING week_start,area,text,revision,updated_at`,
      )
      .bind(week, area, text, now, now, saved?.revision ?? 0)
      .first<BetRow>(),
  );
  // Saved by someone else since it was read.
  if (!written) conflict();
  return betMessage(written);
}
