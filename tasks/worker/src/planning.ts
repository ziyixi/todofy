/**
 * Planning rules (migrations/0006_planning.sql, proto/tasks/ui/v1/task.proto fields 31-38 and plan.proto), pure
 * functions ported from Todofy's core/plus.py (native branch), core/native_plan.py and core/plan.py. Days are
 * account-local YYYY-MM-DD; `today` is Tasks' today and `week` its Monday.
 */
import { addDays, daysBetween } from '@ziyixi/task-dates';
import { invalid, precondition } from './errors.ts';

export const STAGES = ['none', 'quarterly', 'monthly', 'weekly', 'committed'] as const;
export const AREAS = ['unassigned', 'work', 'personal'] as const;
/** The planning flags, in the order Task.planning_flags lists them. */
export const FLAGS = ['quick', 'waiting', 'parked', 'active', 'onhold', 'routine', 'task'] as const;
/** Plan's Review lanes, in board order. */
export const LANES = ['start', 'waiting', 'parked', 'quarterly', 'monthly', 'weekly', 'committed'] as const;
export const MAX_LEAD_DAYS = 365;
/** Dependencies one task keeps, done ones included, and the most there are in all. */
export const MAX_DEPENDENCIES = 5;
export const MAX_ALL_DEPENDENCIES = 300;
export const MAX_LANE_TASKS = 100;
/** In UTF-16 code units, as Plan's input counts them. */
export const MAX_BET_LENGTH = 160;
export const BET_AREAS = ['work', 'personal'] as const;

/** A task row's planning columns. */
export interface PlanningRow {
  stage: string;
  committed_week: string;
  area: string;
  lead_days: number;
  planning_flags: string;
  deadline: string;
  due_date: string;
}

/** The Monday of a day's week. */
export function mondayOf(day: string): string {
  return addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
}
export function flagsOf(row: Pick<PlanningRow, 'planning_flags'>): string[] {
  return JSON.parse(row.planning_flags) as string[];
}
/** The stored stage after the Monday rollover: a commitment for a week that has ended is weekly. */
export function rolledStage(row: Pick<PlanningRow, 'stage' | 'committed_week'>, week: string): string {
  return row.stage === 'committed' && row.committed_week < week ? 'weekly' : row.stage;
}
/** A task's planning fields as Task answers them on `today`, with its flags read once. */
export interface PlanningView {
  flags: string[];
  /** The rolled stage, except that a Quick task is never weekly or monthly. */
  stage: string;
  /**
   * The Review lane: the stage, or weekly for an unstaged task scheduled, or else with a deadline, before seven days
   * from today, overdue included, unless it is a standalone or Quick action, on hold or routine.
   */
  boardStage: string;
  /** Past the deadline, or inside its lead days while not waiting; never while active or parked. */
  mustStart: boolean;
  /** A deadline without lead days, on a task that is neither active nor parked. */
  missingLead: boolean;
}
export function planningView(row: PlanningRow, today: string): PlanningView {
  const flags = flagsOf(row);
  const has = (flag: string) => flags.includes(flag);
  let stage = rolledStage(row, mondayOf(today));
  if ((stage === 'weekly' || stage === 'monthly') && has('quick')) stage = 'none';
  const date = row.due_date || row.deadline;
  const dated = Boolean(date) && !['task', 'quick', 'onhold', 'routine'].some(has) && date < addDays(today, 7);
  const resting = has('active') || has('parked');
  const days = row.deadline ? daysBetween(today, row.deadline) : 0;
  return {
    flags,
    stage,
    boardStage: stage === 'none' && dated ? 'weekly' : stage,
    mustStart:
      Boolean(row.deadline) &&
      !resting &&
      (days < 0 || (!has('waiting') && row.lead_days > 0 && days <= row.lead_days)),
    missingLead: Boolean(row.deadline) && !row.lead_days && !resting,
  };
}

/** Checked, deduplicated planning flags in FLAGS order; quick implies task. */
export function checkedFlags(flags: readonly string[]): string[] {
  if (flags.includes('blocked')) invalid('Dependencies say what blocks a task; blocked cannot be set');
  for (const flag of flags) if (!(FLAGS as readonly string[]).includes(flag)) invalid('Unknown planning flag');
  const set = new Set(flags);
  if (set.has('quick')) set.add('task');
  return FLAGS.filter((flag) => set.has(flag));
}
/**
 * A write's planning columns (apply_plan, apply_lead): `next` holds the written values over `old`, the stored row,
 * and `stageWritten` says whether the write named the stage. A stage it did not name takes the rollover, so the next
 * write of a commitment for an ended week stores it as weekly. Newly setting parked clears the stage and active, and
 * no deadline leaves no lead days. A commitment is for membershipWeek's week, which never moves back; any other stage
 * keeps no week.
 */
export function plannedRow<T extends PlanningRow>(old: PlanningRow, next: T, today: string, stageWritten: boolean): T {
  if (!(STAGES as readonly string[]).includes(next.stage)) invalid('Choose a planning stage');
  if (!(AREAS as readonly string[]).includes(next.area)) invalid('Choose work, personal or unassigned');
  if (!Number.isInteger(next.lead_days) || next.lead_days < 0 || next.lead_days > MAX_LEAD_DAYS)
    invalid(`Start ahead takes 0 to ${String(MAX_LEAD_DAYS)} days`);
  const week = mondayOf(today);
  let flags = checkedFlags(flagsOf(next));
  let stage = stageWritten ? next.stage : rolledStage(old, week);
  if (flags.includes('parked') && !flagsOf(old).includes('parked')) {
    stage = 'none';
    flags = flags.filter((flag) => flag !== 'active');
  }
  let committedWeek = '';
  if (stage === 'committed') {
    const chosen = stageWritten ? membershipWeek(today, week) : '';
    committedWeek = old.committed_week > chosen ? old.committed_week : chosen;
  }
  return {
    ...next,
    stage,
    committed_week: committedWeek,
    lead_days: next.deadline ? next.lead_days : 0,
    planning_flags: JSON.stringify(flags),
  };
}
/**
 * The week a commitment made today is for: on the week's last day, Sunday, a commitment is a choice for the next
 * week, so Monday's rollover leaves it in place.
 */
export function membershipWeek(today: string, week: string): string {
  return today === addDays(week, 6) ? addDays(week, 7) : week;
}

/** A dependency as the rules see it: the task that waits and its prerequisite. */
export interface Edge {
  task: string;
  prerequisite: string;
}
/** Whether `from` waits for `to` through `holding` dependencies (a cycle already in them still ends). */
export function waitsThrough(holding: readonly Edge[], from: string, to: string): boolean {
  const seen = new Set([from]);
  const pending = [from];
  for (let current = pending.pop(); current !== undefined; current = pending.pop())
    for (const edge of holding)
      if (edge.task === current && !seen.has(edge.prerequisite)) {
        if (edge.prerequisite === to) return true;
        seen.add(edge.prerequisite);
        pending.push(edge.prerequisite);
      }
  return false;
}
export interface StoredEdge extends Edge {
  /**
   * It still holds back its task: the prerequisite is open, in an active project and, when it repeats, not completed
   * since.
   */
  holding: boolean;
}
/**
 * One task's new set of prerequisites (check_dependency, for a whole set): what to remove and what to add. `edges`
 * are every stored dependency, oldest first. A new prerequisite must not wait for the task through dependencies that
 * hold. Over a limit (MAX_DEPENDENCIES for the task, done ones included, MAX_ALL_DEPENDENCIES in all), the task's
 * oldest done dependency gives way, then the next oldest; with none left to give way the write is refused.
 */
export function dependencyChange(
  edges: readonly StoredEdge[],
  task: string,
  wanted: readonly string[],
): { removed: string[]; added: string[] } {
  const own = edges.filter((edge) => edge.task === task);
  const removed = own.filter((edge) => !wanted.includes(edge.prerequisite)).map((edge) => edge.prerequisite);
  const added = wanted.filter((id) => !own.some((edge) => edge.prerequisite === id));
  const holding = edges.filter((edge) => edge.holding);
  for (const id of added)
    if (id === task || waitsThrough(holding, id, task)) precondition('A task cannot wait for a task that waits for it');
  // Removing only always succeeds, even over a limit (a restored store, say).
  if (!added.length) return { removed, added };
  let count = wanted.length;
  let total = edges.length - removed.length + added.length;
  for (const edge of own.filter((candidate) => !candidate.holding && wanted.includes(candidate.prerequisite))) {
    if (count <= MAX_DEPENDENCIES && total <= MAX_ALL_DEPENDENCIES) break;
    removed.push(edge.prerequisite);
    count--;
    total--;
  }
  if (count > MAX_DEPENDENCIES || total > MAX_ALL_DEPENDENCIES)
    precondition(
      `A task waits for at most ${String(MAX_DEPENDENCIES)} tasks, and there are at most ${String(MAX_ALL_DEPENDENCIES)} dependencies in all`,
    );
  return { removed, added };
}

/** A Bet as stored: one line, each run of whitespace or control characters one space, trimmed. */
export function betText(text: string): string {
  if (/\p{Cs}/u.test(text)) invalid('A goal cannot contain a lone surrogate');
  const line = text
    .replace(/\p{Cc}/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean)
    .join(' ');
  if (line.length > MAX_BET_LENGTH) invalid(`A goal is at most ${String(MAX_BET_LENGTH)} characters`);
  return line;
}
/** The weeks a plan shows Bets for: the previous one, this one and the next one. */
export function betWeeks(week: string): [string, string, string] {
  return [addDays(week, -7), week, addDays(week, 7)];
}
/** Only this week's and the next week's Bets take a write, so an ended week's Bet stays as it was. */
export function betWritable(betWeek: string, week: string): boolean {
  return betWeek === week || betWeek === addDays(week, 7);
}

export type Lanes = Partial<Record<string, string[]>>;
/**
 * The board with `lane` in the order of `ids`, each once and the first MAX_LANE_TASKS: those tasks leave every other
 * lane, since a task is in one lane, and a lane left empty leaves the board.
 */
export function arrangeLane(lanes: Lanes, lane: string, ids: readonly string[]): Lanes {
  const arranged = [...new Set(ids)].slice(0, MAX_LANE_TASKS);
  const taken = new Set(arranged);
  const result: Lanes = {};
  for (const name of LANES) {
    const tasks = name === lane ? arranged : (lanes[name] ?? []).filter((id) => !taken.has(id));
    if (tasks.length) result[name] = tasks;
  }
  return result;
}
