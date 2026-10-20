/**
 * The one-time import of Todofy's planning store into Tasks (docs/backup.md "One-time planning import"), run by
 * .github/workflows/tasks-planning-import.yml right after the release that moved planning into Tasks
 * (migrations/0006_planning.sql). From that release on, nothing writes Todofy's planning tables.
 *
 * Todofy keys its planning by its own task IDs (plan_tasks); a row with provider 'tasks' names the Tasks ID. For live
 * Tasks tasks only, the import copies:
 * - each task's planning state onto its row, and only onto a row whose planning columns still hold their defaults, so
 *   a fact set in Tasks since the release is never overwritten. It writes `revision+1` and, as `updated_at`, the later
 *   of the row's and the state's, which is what Todofy's overlay reported. A commitment keeps the week it was recorded
 *   for (plus_weeks), else the week in effect (plus_settings), so it reads as weekly once that week has ended;
 * - each dependency of an open task, with its baseline and creation time, unless Tasks has that pair, even a removed
 *   one. As in Todofy, a completed task waits for nothing;
 * - each week's Bets that Tasks lacks. An empty Bet is a cleared one and stays out;
 * - the Review lanes the owner arranged, while Tasks' board is untouched (revision 1).
 * Every statement repeats its guard, so applying the SQL again changes nothing and the next dry run counts nothing
 * pending.
 *
 * The inputs are `wrangler d1 execute --json` answers to the read-only EXPORTS. Only checked IDs, days and fixed words
 * are quoted into the SQL; a Bet's text goes in hex-encoded. The counts name no task, title or Bet.
 */
export class PlanningImportError extends Error {}

/** One read-only SELECT per answer, against the D1 of `app`; each answer is saved as `<name>.json`. */
export const EXPORTS = [
  { app: 'todofy', name: 'todofy.plan_tasks', sql: "SELECT id, external_id FROM plan_tasks WHERE provider='tasks'" },
  {
    app: 'todofy',
    name: 'todofy.plan_task_state',
    sql:
      'SELECT task_id, stage, area, lead_days, quick, waiting, blocked, parked, active, onhold, routine, task, ' +
      'updated_at FROM plan_task_state',
  },
  {
    app: 'todofy',
    name: 'todofy.plan_edges',
    sql:
      'SELECT task_id, prerequisite_id, baseline_count, created_at FROM plan_edges ' +
      "WHERE kind='waits_for' ORDER BY created_at, rowid",
  },
  {
    app: 'todofy',
    name: 'todofy.plan_notes',
    sql: "SELECT period, area, body, updated_at FROM plan_notes WHERE kind='bets'",
  },
  { app: 'todofy', name: 'todofy.plan_settings', sql: "SELECT value, updated_at FROM plan_settings WHERE key='board'" },
  { app: 'todofy', name: 'todofy.plus_weeks', sql: 'SELECT task_id, week_start FROM plus_weeks' },
  { app: 'todofy', name: 'todofy.plus_settings', sql: 'SELECT week_start FROM plus_settings WHERE id=1' },
  {
    app: 'tasks',
    name: 'tasks.tasks',
    sql:
      "SELECT id, completed, deadline<>'' AS has_deadline, stage, area, lead_days, planning_flags FROM tasks " +
      'WHERE deleted_at IS NULL',
  },
  { app: 'tasks', name: 'tasks.task_dependencies', sql: 'SELECT task_id, prerequisite_id FROM task_dependencies' },
  { app: 'tasks', name: 'tasks.weekly_bets', sql: 'SELECT week_start, area FROM weekly_bets' },
  { app: 'tasks', name: 'tasks.plan_board', sql: "SELECT revision FROM plan_board WHERE id='board'" },
] as const;

// The vocabularies of migrations/0006_planning.sql and worker/src/planning.ts.
const STAGES = ['none', 'quarterly', 'monthly', 'weekly', 'committed'];
const AREAS = ['unassigned', 'work', 'personal'];
/** Task.planning_flags, in their order. Todofy's `blocked` is not one: dependencies say what blocks a task. */
const FLAGS = ['quick', 'waiting', 'parked', 'active', 'onhold', 'routine', 'task'];
const LANES = ['start', 'waiting', 'parked', 'quarterly', 'monthly', 'weekly', 'committed'];
const BET_AREAS = ['work', 'personal'];
/** In UTF-16 code units, as both apps count it. */
const MAX_BET_LENGTH = 160;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DAY = /^\d{4}-\d\d-\d\d$/;

export interface Facts {
  id: string;
  stage: string;
  committedWeek: string;
  area: string;
  leadDays: number;
  flags: string[];
  /** Milliseconds: the state's last change in Todofy. */
  updatedAt: number;
}
export interface Dependency {
  task: string;
  prerequisite: string;
  baseline: number;
  /** Milliseconds. */
  createdAt: number;
}
export interface Bet {
  week: string;
  area: string;
  text: string;
  /** Milliseconds. */
  updatedAt: number;
}
export interface PlanningImport {
  facts: Facts[];
  dependencies: Dependency[];
  bets: Bet[];
  /** The arranged lanes to write, or null when there are none or Tasks' board has changed since the release. */
  board: { lanes: Record<string, string[]>; updatedAt: number } | null;
  counts: {
    states: {
      all: number;
      pending: number;
      /** The Tasks row already has planning facts: imported before, or set in Tasks since the release. */
      present: number;
      /** Nothing to import: no stage, area, lead days or flag (Todofy's `blocked` alone counts as none). */
      empty: number;
      /** The state names a task that is not live in Tasks. */
      orphan: number;
    };
    dependencies: {
      all: number;
      pending: number;
      present: number;
      /** Either task is not live in Tasks, or the waiting task is completed. */
      orphan: number;
    };
    /** Bets with text; cleared ones are not counted. */
    bets: { all: number; pending: number; present: number };
    board: {
      lanes: number;
      tasks: number;
      /** Lane entries naming a task that is not live in Tasks. */
      orphan: number;
      pending: number;
    };
    pending: number;
  };
}

type Row = Record<string, unknown>;

/** The rows of a `wrangler d1 execute --json` answer: `[{results: [...]}, ...]`. */
function rows(answers: Record<string, unknown>, name: string): Row[] {
  const answer = answers[name];
  if (!Array.isArray(answer)) throw new PlanningImportError(`EXPORT_INVALID: ${name}`);
  return answer.flatMap((statement: unknown) => {
    const results = (statement as { results?: unknown } | null)?.results;
    if (!Array.isArray(results)) throw new PlanningImportError(`EXPORT_INVALID: ${name}`);
    return results.map((row: unknown) => {
      if (!row || typeof row !== 'object' || Array.isArray(row))
        throw new PlanningImportError(`EXPORT_INVALID: ${name}`);
      return row as Row;
    });
  });
}
function check(ok: boolean, name: string): void {
  if (!ok) throw new PlanningImportError(`EXPORT_INVALID: ${name}`);
}
function count(value: unknown, name: string): number {
  check(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, name);
  return value as number;
}
function word(value: unknown, allowed: readonly string[], name: string): string {
  check(typeof value === 'string' && allowed.includes(value), name);
  return value as string;
}
function matching(value: unknown, pattern: RegExp, name: string): string {
  check(typeof value === 'string' && pattern.test(value), name);
  return value as string;
}
function flag(value: unknown, name: string): boolean {
  check(value === 0 || value === 1, name);
  return value === 1;
}
function monday(day: string): boolean {
  return new Date(`${day}T12:00:00Z`).getUTCDay() === 1;
}
const pair = (left: string, right: string) => `${left} ${right}`;

export function preparePlanningImport(answers: Record<string, unknown>): PlanningImport {
  // Todofy's task IDs: the Tasks ID each one names.
  const taskIds = new Map<number, string>();
  for (const row of rows(answers, 'todofy.plan_tasks')) {
    const id = count(row.id, 'todofy.plan_tasks');
    check(!taskIds.has(id), 'todofy.plan_tasks');
    taskIds.set(id, matching(row.external_id, ID, 'todofy.plan_tasks'));
  }
  // The week each recorded commitment is for, by Tasks ID, and the week in effect.
  const weeks = new Map<string, string>();
  for (const row of rows(answers, 'todofy.plus_weeks')) {
    const id = matching(row.task_id, ID, 'todofy.plus_weeks');
    check(!weeks.has(id), 'todofy.plus_weeks');
    weeks.set(id, matching(row.week_start, DAY, 'todofy.plus_weeks'));
  }
  const plusSettings = rows(answers, 'todofy.plus_settings');
  check(plusSettings.length <= 1, 'todofy.plus_settings');
  const currentWeek = plusSettings[0] && matching(plusSettings[0].week_start, DAY, 'todofy.plus_settings');

  // Live Tasks tasks, and what Tasks already holds.
  const live = new Map<string, { open: boolean; hasDeadline: boolean; untouched: boolean }>();
  for (const row of rows(answers, 'tasks.tasks')) {
    const id = matching(row.id, ID, 'tasks.tasks');
    check(!live.has(id), 'tasks.tasks');
    live.set(id, {
      open: !flag(row.completed, 'tasks.tasks'),
      hasDeadline: flag(row.has_deadline, 'tasks.tasks'),
      untouched:
        row.stage === 'none' && row.area === 'unassigned' && row.lead_days === 0 && row.planning_flags === '[]',
    });
  }
  const storedDependencies = new Set(
    rows(answers, 'tasks.task_dependencies').map((row) =>
      pair(
        matching(row.task_id, ID, 'tasks.task_dependencies'),
        matching(row.prerequisite_id, ID, 'tasks.task_dependencies'),
      ),
    ),
  );
  const storedBets = new Set(
    rows(answers, 'tasks.weekly_bets').map((row) =>
      pair(matching(row.week_start, DAY, 'tasks.weekly_bets'), word(row.area, BET_AREAS, 'tasks.weekly_bets')),
    ),
  );
  const boards = rows(answers, 'tasks.plan_board');
  check(boards.length === 1, 'tasks.plan_board');
  const boardRevision = count(boards[0]?.revision, 'tasks.plan_board');

  const plan: PlanningImport = {
    facts: [],
    dependencies: [],
    bets: [],
    board: null,
    counts: {
      states: { all: 0, pending: 0, present: 0, empty: 0, orphan: 0 },
      dependencies: { all: 0, pending: 0, present: 0, orphan: 0 },
      bets: { all: 0, pending: 0, present: 0 },
      board: { lanes: 0, tasks: 0, orphan: 0, pending: 0 },
      pending: 0,
    },
  };
  const { counts } = plan;

  const seenStates = new Set<number>();
  for (const row of rows(answers, 'todofy.plan_task_state')) {
    const name = 'todofy.plan_task_state';
    const planId = count(row.task_id, name);
    check(!seenStates.has(planId), name);
    seenStates.add(planId);
    const stage = word(row.stage, STAGES, name);
    const area = word(row.area, AREAS, name);
    const leadDays = count(row.lead_days, name);
    check(leadDays <= 365, name);
    flag(row.blocked, name);
    const set = new Set(FLAGS.filter((value) => flag(row[value], name)));
    if (set.has('quick')) set.add('task');
    const flags = FLAGS.filter((value) => set.has(value));
    const updatedAt = count(row.updated_at, name) * 1000;
    counts.states.all++;
    const id = taskIds.get(planId);
    const task = id === undefined ? undefined : live.get(id);
    // As every Tasks write stores it: no deadline, no start-ahead days.
    const lead = task && !task.hasDeadline ? 0 : leadDays;
    if (stage === 'none' && area === 'unassigned' && lead === 0 && !flags.length) counts.states.empty++;
    else if (id === undefined || !task) counts.states.orphan++;
    else if (!task.untouched) counts.states.present++;
    else {
      let committedWeek = '';
      if (stage === 'committed') {
        const week = weeks.get(id) ?? currentWeek;
        if (!week) throw new PlanningImportError('COMMITMENT_WEEK_UNKNOWN');
        committedWeek = week;
      }
      plan.facts.push({ id, stage, committedWeek, area, leadDays: lead, flags, updatedAt });
    }
  }

  for (const row of rows(answers, 'todofy.plan_edges')) {
    const name = 'todofy.plan_edges';
    const task = taskIds.get(count(row.task_id, name));
    const prerequisite = taskIds.get(count(row.prerequisite_id, name));
    const baseline = count(row.baseline_count, name);
    const createdAt = count(row.created_at, name) * 1000;
    counts.dependencies.all++;
    if (!task || !prerequisite || !live.get(task)?.open || !live.has(prerequisite)) counts.dependencies.orphan++;
    else if (storedDependencies.has(pair(task, prerequisite))) counts.dependencies.present++;
    else plan.dependencies.push({ task, prerequisite, baseline, createdAt });
  }

  for (const row of rows(answers, 'todofy.plan_notes')) {
    const name = 'todofy.plan_notes';
    const week = matching(row.period, DAY, name);
    const area = word(row.area, BET_AREAS, name);
    check(monday(week) && typeof row.body === 'string' && row.body.length <= MAX_BET_LENGTH, name);
    const text = row.body as string;
    const updatedAt = count(row.updated_at, name) * 1000;
    if (!text) continue;
    counts.bets.all++;
    if (storedBets.has(pair(week, area))) counts.bets.present++;
    else plan.bets.push({ week, area, text, updatedAt });
  }

  const boardSettings = rows(answers, 'todofy.plan_settings');
  check(boardSettings.length <= 1, 'todofy.plan_settings');
  const setting = boardSettings[0];
  if (setting) {
    const name = 'todofy.plan_settings';
    let document: unknown;
    try {
      document = JSON.parse(String(setting.value));
    } catch {
      check(false, name);
    }
    // {"lanes": {"<lane>": [<plan_tasks.id>, ...]}}: Todofy's core/plan.py arrange_lane.
    const saved = (document as { lanes?: unknown } | null)?.lanes ?? {};
    check(typeof saved === 'object' && saved !== null && !Array.isArray(saved), name);
    const lanes: Record<string, string[]> = {};
    const placed = new Set<string>();
    for (const lane of LANES) {
      const planIds = (saved as Record<string, unknown>)[lane] ?? [];
      check(Array.isArray(planIds), name);
      const ids: string[] = [];
      for (const planId of planIds as unknown[]) {
        const id = taskIds.get(count(planId, name));
        if (!id || !live.has(id)) counts.board.orphan++;
        // A task is in one lane, in both apps.
        else if (!placed.has(id)) {
          placed.add(id);
          ids.push(id);
        }
      }
      if (ids.length) lanes[lane] = ids;
    }
    counts.board.lanes = Object.keys(lanes).length;
    counts.board.tasks = placed.size;
    if (counts.board.lanes && boardRevision === 1)
      plan.board = { lanes, updatedAt: count(setting.updated_at, name) * 1000 };
  }

  counts.states.pending = plan.facts.length;
  counts.dependencies.pending = plan.dependencies.length;
  counts.bets.pending = plan.bets.length;
  counts.board.pending = plan.board ? 1 : 0;
  counts.pending = counts.states.pending + counts.dependencies.pending + counts.bets.pending + counts.board.pending;
  return plan;
}

const whole = (value: number) => Number.isSafeInteger(value) && value >= 0;

/** Whether every value the SQL quotes is one preparePlanningImport could have made. */
function quotable({ facts, dependencies, bets, board }: PlanningImport): boolean {
  return (
    facts.every(
      (row) =>
        ID.test(row.id) &&
        STAGES.includes(row.stage) &&
        (row.committedWeek === '' || DAY.test(row.committedWeek)) &&
        AREAS.includes(row.area) &&
        whole(row.leadDays) &&
        row.flags.every((value) => FLAGS.includes(value)) &&
        whole(row.updatedAt),
    ) &&
    dependencies.every(
      (row) => ID.test(row.task) && ID.test(row.prerequisite) && whole(row.baseline) && whole(row.createdAt),
    ) &&
    bets.every((row) => DAY.test(row.week) && BET_AREAS.includes(row.area) && whole(row.updatedAt)) &&
    (!board ||
      (whole(board.updatedAt) &&
        Object.entries(board.lanes).every(([lane, ids]) => LANES.includes(lane) && ids.every((id) => ID.test(id)))))
  );
}

/** One guarded statement per change, for `wrangler d1 execute --file`. */
export function planningImportSql(plan: PlanningImport): string {
  if (!quotable(plan)) throw new PlanningImportError('PLAN_INVALID');
  const statements = [
    ...plan.facts.map(
      (row) =>
        `UPDATE tasks SET stage='${row.stage}',committed_week='${row.committedWeek}',area='${row.area}',` +
        `lead_days=${String(row.leadDays)},planning_flags='${JSON.stringify(row.flags)}',revision=revision+1,` +
        `updated_at=MAX(updated_at,${String(row.updatedAt)}) WHERE id='${row.id}' AND deleted_at IS NULL ` +
        "AND stage='none' AND area='unassigned' AND lead_days=0 AND planning_flags='[]';",
    ),
    ...plan.dependencies.map(
      (row) =>
        'INSERT INTO task_dependencies(task_id,prerequisite_id,baseline_count,created_at,updated_at) ' +
        `SELECT '${row.task}','${row.prerequisite}',${String(row.baseline)},${String(row.createdAt)},` +
        `${String(row.createdAt)} WHERE EXISTS(SELECT 1 FROM tasks WHERE id='${row.task}' AND deleted_at IS NULL ` +
        `AND completed=0) AND EXISTS(SELECT 1 FROM tasks WHERE id='${row.prerequisite}' AND deleted_at IS NULL) ` +
        'ON CONFLICT DO NOTHING;',
    ),
    ...plan.bets.map(
      (row) =>
        'INSERT INTO weekly_bets(week_start,area,text,revision,created_at,updated_at) ' +
        `VALUES('${row.week}','${row.area}',CAST(X'${Buffer.from(row.text, 'utf8').toString('hex')}' AS TEXT),1,` +
        `${String(row.updatedAt)},${String(row.updatedAt)}) ON CONFLICT DO NOTHING;`,
    ),
    ...(plan.board
      ? [
          `UPDATE plan_board SET lanes='${JSON.stringify(plan.board.lanes)}',revision=revision+1,` +
            `updated_at=${String(plan.board.updatedAt)} WHERE id='board' AND revision=1;`,
        ]
      : []),
  ];
  return statements.length ? statements.join('\n') + '\n' : 'SELECT 0 AS pending_count;\n';
}
