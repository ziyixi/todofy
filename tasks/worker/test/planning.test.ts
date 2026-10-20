/**
 * The planning rules of src/planning.ts, as tables ported from Todofy's Python cases (tests/unit/test_plus.py,
 * test_native_plan.py, test_plus_dependencies.py, test_plan_store.py and test_plus_bets.py). Synthetic values only.
 */
import { describe, expect, test } from 'vitest';
import {
  arrangeLane,
  betText,
  betWeeks,
  betWritable,
  checkedFlags,
  dependencyChange,
  MAX_LANE_TASKS,
  membershipWeek,
  mondayOf,
  plannedRow,
  planningView,
  rolledStage,
  waitsThrough,
  type PlanningRow,
  type StoredEdge,
} from '../src/planning.ts';

const TODAY = '2026-10-13'; // a Tuesday
const WEEK = '2026-10-12';
const SUNDAY = '2026-10-18';
const NEXT = '2026-10-19';

function row(fields: Partial<PlanningRow> & { flags?: string[] } = {}): PlanningRow {
  const { flags = [], ...rest } = fields;
  return {
    stage: 'none',
    committed_week: '',
    area: 'unassigned',
    lead_days: 0,
    deadline: '',
    due_date: '',
    planning_flags: JSON.stringify(flags),
    ...rest,
  };
}
function expectRefused(action: () => unknown, reason: string) {
  expect(action).toThrow(expect.objectContaining({ reason }) as Error);
}

describe('stages', () => {
  test('the week starts on Monday', () => {
    expect([SUNDAY, NEXT, TODAY, '2027-01-01'].map(mondayOf)).toEqual([WEEK, NEXT, WEEK, '2026-12-28']);
  });

  test.each([
    ['committed this week', { stage: 'committed', committed_week: WEEK }, 'committed'],
    ['committed for next week on Sunday', { stage: 'committed', committed_week: NEXT }, 'committed'],
    ['a commitment for an ended week rolls over', { stage: 'committed', committed_week: '2026-10-05' }, 'weekly'],
    ['other stages never roll over', { stage: 'monthly', committed_week: '' }, 'monthly'],
  ])('%s', (_, fields, stage) => {
    expect(rolledStage(row(fields), WEEK)).toBe(stage);
  });

  test("a Quick task's week or month gives no stage, its quarter and commitment do", () => {
    for (const stage of ['weekly', 'monthly'])
      expect(planningView(row({ stage, flags: ['quick', 'task'] }), TODAY).stage).toBe('none');
    for (const stage of ['quarterly', 'committed'])
      expect(planningView(row({ stage, committed_week: WEEK, flags: ['quick', 'task'] }), TODAY).stage).toBe(stage);
  });

  test.each([
    ['an explicit stage beats the date', { stage: 'monthly', due_date: TODAY }, 'monthly'],
    ['due within seven days', { due_date: '2026-10-19' }, 'weekly'],
    ['overdue', { due_date: '2026-10-01' }, 'weekly'],
    ['a deadline within seven days', { deadline: TODAY }, 'weekly'],
    ['the scheduled date comes first', { due_date: '2027-01-01', deadline: TODAY }, 'none'],
    ['seven days on is too far', { due_date: '2026-10-20' }, 'none'],
    ['routine', { due_date: TODAY, flags: ['routine'] }, 'none'],
    ['on hold', { due_date: TODAY, flags: ['onhold'] }, 'none'],
    ['a standalone action', { due_date: TODAY, flags: ['task'] }, 'none'],
    ['Quick', { due_date: TODAY, flags: ['quick', 'task'] }, 'none'],
    ['waiting still counts', { due_date: TODAY, flags: ['waiting'] }, 'weekly'],
    ['no date', {}, 'none'],
  ])('the Review lane: %s', (_, fields, stage) => {
    expect(planningView(row(fields), TODAY).boardStage).toBe(stage);
  });
});

describe('start ahead', () => {
  test.each([
    ['inside its lead days', { deadline: '2026-10-26', lead_days: 14 }, true],
    ['a day before its lead days', { deadline: '2026-10-28', lead_days: 14 }, false],
    ['the last day of three', { deadline: '2026-10-16', lead_days: 3 }, true],
    ['one day too early', { deadline: '2026-10-17', lead_days: 3 }, false],
    ['a custom 21 days', { deadline: '2026-11-01', lead_days: 21 }, true],
    ['the scheduled date is no deadline', { due_date: TODAY, lead_days: 14 }, false],
    ['waiting holds it inside its lead days', { deadline: TODAY, lead_days: 14, flags: ['waiting'] }, false],
    ['but not past its deadline', { deadline: '2026-10-12', flags: ['waiting'] }, true],
    ['in progress', { deadline: '2026-10-01', lead_days: 7, flags: ['active'] }, false],
    ['parked', { deadline: '2026-10-01', flags: ['parked'] }, false],
    ['no lead days before its deadline', { deadline: '2026-10-14' }, false],
    ['no lead days on its deadline', { deadline: TODAY }, false],
  ])('must start: %s', (_, fields, expected) => {
    expect(planningView(row(fields), TODAY).mustStart).toBe(expected);
  });

  test('a deadline without lead days misses one, unless the task is in progress or parked', () => {
    expect(planningView(row({ deadline: TODAY }), TODAY).missingLead).toBe(true);
    expect(planningView(row({ deadline: TODAY, lead_days: 1 }), TODAY).missingLead).toBe(false);
    expect(planningView(row({ deadline: TODAY, flags: ['active'] }), TODAY).missingLead).toBe(false);
    expect(planningView(row({ deadline: TODAY, flags: ['parked'] }), TODAY).missingLead).toBe(false);
    expect(planningView(row(), TODAY).missingLead).toBe(false);
  });
});

describe('writes', () => {
  /** `next` over the stored `old`, as UpdateTask applies its mask's values; `stageWritten` when it names stage. */
  const write = (
    old: PlanningRow,
    { flags, ...next }: Partial<PlanningRow> & { flags?: string[] },
    stageWritten = false,
    today = TODAY,
  ) =>
    plannedRow(
      old,
      { ...old, ...next, ...(flags ? { planning_flags: JSON.stringify(flags) } : {}) },
      today,
      stageWritten,
    );

  test('flags are checked, in one order, and Quick is a standalone action', () => {
    expect(checkedFlags(['task', 'quick', 'waiting', 'quick'])).toEqual(['quick', 'waiting', 'task']);
    expectRefused(() => checkedFlags(['blocked']), 'BAD_REQUEST');
    expectRefused(() => checkedFlags(['bets']), 'BAD_REQUEST');
    // Clearing Quick keeps the standalone action; it is cleared on its own.
    expect(flagsOf(write(row({ flags: ['quick', 'task'] }), { flags: ['task'] }))).toEqual(['task']);
    expect(flagsOf(write(row({ flags: ['quick', 'task'] }), { flags: [] }))).toEqual([]);
  });

  test('parking clears the stage and in progress; a parked task keeps a stage written later', () => {
    const parked = write(row({ stage: 'weekly', flags: ['active'] }), { flags: ['active', 'parked'] });
    expect([parked.stage, flagsOf(parked)]).toEqual(['none', ['parked']]);
    const staged = write(parked, { stage: 'monthly' }, true);
    expect([staged.stage, flagsOf(staged)]).toEqual(['monthly', ['parked']]);
  });

  test('a stage, an area and lead days are checked', () => {
    expectRefused(() => write(row(), { stage: 'later' }, true), 'BAD_REQUEST');
    expectRefused(() => write(row(), { area: 'office' }), 'BAD_REQUEST');
    for (const lead_days of [-1, 366, 1.5])
      expectRefused(() => write(row({ deadline: TODAY }), { lead_days }), 'BAD_REQUEST');
    expect(write(row({ deadline: TODAY }), { lead_days: 365 }).lead_days).toBe(365);
  });

  test('a write that leaves no deadline stores no lead days', () => {
    expect(write(row({ deadline: TODAY, lead_days: 3 }), { deadline: '' }).lead_days).toBe(0);
    expect(write(row(), { lead_days: 3 }).lead_days).toBe(0);
  });

  test('only a commitment chosen on the last day waits for the next week', () => {
    expect(membershipWeek(SUNDAY, WEEK)).toBe(NEXT);
    for (const today of [WEEK, '2026-10-14', '2026-10-17']) expect(membershipWeek(today, WEEK)).toBe(WEEK);
    expect(write(row(), { stage: 'committed' }, true, SUNDAY).committed_week).toBe(NEXT);
    expect(write(row(), { stage: 'committed' }, true, TODAY).committed_week).toBe(WEEK);
    // In progress as well, it is still a commitment for the next week.
    expect(write(row({ flags: ['active'] }), { stage: 'committed' }, true, SUNDAY).committed_week).toBe(NEXT);
  });

  test('a Sunday choice never moves back, and other writes that Sunday keep it', () => {
    const chosen = row({ stage: 'committed', committed_week: NEXT });
    expect(write(chosen, { flags: ['active'] }, false, SUNDAY).committed_week).toBe(NEXT);
    expect(write(chosen, { area: 'work' }, false, SUNDAY).committed_week).toBe(NEXT);
    expect(write(chosen, { stage: 'committed' }, true, SUNDAY).committed_week).toBe(NEXT);
    expect(write(chosen, { stage: 'committed' }, true, '2026-10-14').committed_week).toBe(NEXT);
  });

  test('another stage keeps no week; the next write of an ended commitment stores it as weekly', () => {
    const chosen = row({ stage: 'committed', committed_week: WEEK });
    expect(write(chosen, { stage: 'weekly' }, true)).toMatchObject({ stage: 'weekly', committed_week: '' });
    const ended = row({ stage: 'committed', committed_week: '2026-10-05' });
    expect(write(ended, { area: 'work' })).toMatchObject({ stage: 'weekly', committed_week: '' });
    expect(write(ended, { stage: 'committed' }, true)).toMatchObject({ stage: 'committed', committed_week: WEEK });
  });
});

function flagsOf(value: PlanningRow): string[] {
  return JSON.parse(value.planning_flags) as string[];
}

describe('dependencies', () => {
  const edge = (task: string, prerequisite: string, holding = true): StoredEdge => ({ task, prerequisite, holding });

  test('waiting follows dependencies through other tasks, and a cycle already stored still ends', () => {
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('x', 'y'), edge('a', 'd')];
    expect(waitsThrough(edges, 'a', 'c') && waitsThrough(edges, 'a', 'b')).toBe(true);
    expect(waitsThrough(edges, 'c', 'a') || waitsThrough(edges, 'a', 'y')).toBe(false);
    expect(waitsThrough([edge('a', 'b'), edge('b', 'a')], 'a', 'z')).toBe(false);
  });

  const five = Array.from({ length: 5 }, (_, index) => edge('a', `p${String(index)}`));
  const others = Array.from({ length: 299 }, (_, index) => edge(`t${String(index)}`, 'p'));
  const ids = (edges: StoredEdge[], task: string) =>
    edges.filter((value) => value.task === task).map((value) => value.prerequisite);
  test.each([
    ['itself', [], 'a', ['a'], 'PRECONDITION_FAILED'],
    ['each other', [edge('b', 'a')], 'a', ['b'], 'PRECONDITION_FAILED'],
    ['through another', [edge('c', 'b'), edge('b', 'a')], 'a', ['c'], 'PRECONDITION_FAILED'],
    ['five per task', five, 'a', [...ids(five, 'a'), 'b'], 'PRECONDITION_FAILED'],
    ['three hundred in all', [...others, edge('x', 'p')], 'a', ['b'], 'PRECONDITION_FAILED'],
  ])('refused: %s', (_, edges, task, wanted, reason) => {
    expectRefused(() => dependencyChange(edges, task, wanted), reason);
  });

  test.each([
    ['a done one closes no cycle', [edge('b', 'a', false)], 'a', ['b'], { removed: [], added: ['b'] }],
    [
      'the oldest done one gives way at five',
      five.map((value) => ({ ...value, holding: !['p3', 'p1'].includes(value.prerequisite) })),
      'a',
      [...ids(five, 'a'), 'b'],
      { removed: ['p1'], added: ['b'] },
    ],
    [
      'a done one gives way at three hundred',
      [...others, edge('a', 'q', false)],
      'a',
      ['q', 'b'],
      { removed: ['q'], added: ['b'] },
    ],
    [
      'a done one kept stays as it is',
      five.map((value) => ({ ...value, holding: false })),
      'a',
      ids(five, 'a'),
      { removed: [], added: [] },
    ],
    [
      'a shared prerequisite is no cycle',
      [edge('b', 'c'), edge('a', 'c')],
      'a',
      ['c', 'b'],
      { removed: [], added: ['b'] },
    ],
    ['removing', [edge('a', 'b'), edge('a', 'c')], 'a', ['c'], { removed: ['b'], added: [] }],
    ['removing over a limit', [...others, edge('x', 'p'), edge('a', 'b')], 'a', [], { removed: ['b'], added: [] }],
  ])('allowed: %s', (_, edges, task, wanted, expected) => {
    expect(dependencyChange(edges, task, wanted)).toEqual(expected);
  });
});

describe('Bets', () => {
  test.each([
    ['  Ship the draft  ', 'Ship the draft'],
    ['Ship\n the\t\tdraft\r\n', 'Ship the draft'],
    ['Ship\u0000the\u001bdraft\u007f', 'Ship the draft'],
    ['周末　去徒步', '周末 去徒步'],
    ['Run 👩‍👩‍👧 5k', 'Run 👩‍👩‍👧 5k'],
    [' \n\t ', ''],
  ])('%j is stored as one trimmed line', (text, stored) => {
    expect(betText(text)).toBe(stored);
  });

  test('a Bet is at most 160 UTF-16 code units, collapsed whitespace not counted', () => {
    expect(betText('写'.repeat(160))).toBe('写'.repeat(160));
    expect(betText('😀'.repeat(80))).toBe('😀'.repeat(80));
    for (const text of ['写'.repeat(161), '😀'.repeat(80) + 'a', 'a'.repeat(159) + '😀'])
      expectRefused(() => betText(text), 'BAD_REQUEST');
    expect(betText('a'.repeat(80) + ' '.repeat(200) + 'b'.repeat(79))).toBe('a'.repeat(80) + ' ' + 'b'.repeat(79));
    expectRefused(() => betText('lone \ud800 surrogate'), 'BAD_REQUEST');
  });

  test('a plan shows last, this and next week, and only this week and the next take a write', () => {
    expect(betWeeks(WEEK)).toEqual(['2026-10-05', WEEK, NEXT]);
    expect(betWeeks('2026-12-28')).toEqual(['2026-12-21', '2026-12-28', '2027-01-04']);
    expect(['2026-10-05', WEEK, NEXT, '2026-10-26'].map((week) => betWritable(week, WEEK))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    // On Monday the week that ended Sunday is last week.
    expect([betWritable(WEEK, NEXT), betWritable('2026-10-26', NEXT)]).toEqual([false, true]);
  });
});

describe('the Review board', () => {
  test('arranging a lane takes its tasks from every other lane, in board order', () => {
    const lanes = { weekly: ['1', '2', '3'], monthly: ['4', '2'], waiting: ['5'] };
    expect(arrangeLane(lanes, 'committed', ['3', '2', '3'])).toEqual({
      waiting: ['5'],
      monthly: ['4'],
      weekly: ['1'],
      committed: ['3', '2'],
    });
    expect(Object.keys(arrangeLane(lanes, 'start', ['5']))).toEqual(['start', 'monthly', 'weekly']);
    expect(arrangeLane(lanes, 'weekly', [])).toEqual({ waiting: ['5'], monthly: ['4', '2'] });
    const many = Array.from({ length: MAX_LANE_TASKS + 20 }, (_, index) => String(index));
    expect(arrangeLane({}, 'parked', many)).toEqual({ parked: many.slice(0, MAX_LANE_TASKS) });
    // A lane this build does not know is dropped.
    expect(arrangeLane({ later: ['9'] }, 'start', ['1'])).toEqual({ start: ['1'] });
  });
});
