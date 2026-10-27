/**
 * Tasks' jobs (src/schedule.ts, gtd.ts, review.ts) on real D1 at fixed clocks, the review read, and the jobs
 * object's Alarm through Ops. America/Los_Angeles: 2026-10-21 is a Wednesday, 2026-10-25 a Sunday (PDT, UTC-7), and
 * 2026-11-01 a Sunday in PST (UTC-8). Synthetic tasks and mail only.
 */
import { create } from '@ziyixi/proto/protobuf';
import { GetWeeklyReviewRequestSchema } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { WeeklyReview_State } from '@ziyixi/proto/tasks/ui/v1/gtd_pb';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Env } from '../../src/env.ts';
import { collectDay } from '../../src/gtd.ts';
import { getWeeklyReview } from '../../src/review.ts';
import { runJobs } from '../../src/schedule.ts';
import { fakeMail, type FakeMail } from './fake-mail.ts';
import { measuredReads, startHarness, type Harness } from './harness.ts';

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Wednesday 07:00 PDT. */
const NOW = Date.parse('2026-10-21T14:00:00Z');
let harness: Harness;
let todofy: FakeMail;
function env(db: D1Database = harness.db): Env {
  return {
    DB: db,
    MAIL: { fetch: (request: Request) => todofy.handle(request) },
    TIME_ZONE: 'America/Los_Angeles',
    PUBLIC_HOST: 'tasks.example.test',
  } as unknown as Env;
}
beforeAll(async () => {
  harness = await startHarness();
  todofy = fakeMail([
    { id: 'mail-2d', title: 'Two days old', receivedAt: Date.now() - 2 * DAY },
    { id: 'mail-5d', title: 'Five days old', receivedAt: Date.now() - 5 * DAY },
    { id: 'mail-new', title: 'New', receivedAt: Date.now() - HOUR },
    { id: 'mail-done', title: 'Converted', receivedAt: Date.now() - 3 * DAY, pending: false },
  ]);
  /** A task created `ageDays` before NOW, with the given columns. */
  const task = (id: string, ageDays: number, fields: Record<string, string | number> = {}) =>
    harness.db
      .prepare(
        `INSERT INTO tasks(id,title,created_at,updated_at${Object.keys(fields).map((column) => `,${column}`).join('')})
        VALUES(?,?,?,?${',?'.repeat(Object.keys(fields).length)})`,
      )
      .bind(id, `Synthetic ${id}`, NOW - ageDays * DAY, NOW, ...Object.values(fields));
  const timed = (at: string) => ({ project_id: 'work', due_date: '2026-10-21', due_datetime: at, due_timezone: 'UTC' });
  await harness.db.batch([
    harness.db.prepare("INSERT INTO projects(id,title,inbox,created_at,updated_at) VALUES('inbox-project','Inbox',1,1,1)"),
    harness.db.prepare("INSERT INTO projects(id,title,created_at,updated_at) VALUES('work','Synthetic work',1,1)"),
    harness.db.prepare(
      "INSERT INTO projects(id,title,archived,created_at,updated_at) VALUES('shelved','Synthetic shelved',1,1,1)",
    ),
    // The Inbox: no project or the Inbox project; i4 is i1's subtask.
    task('i1', 1),
    task('i2', 10, { due_date: '2026-10-20' }),
    task('i3', 20, { project_id: 'inbox-project', due_date: '2026-10-22' }),
    task('i4', 40, { parent_id: 'i1' }),
    // Timed: one past, one later today.
    task('w1', 2, timed('2026-10-21T13:00:00.000Z')),
    task('w2', 3, timed('2026-10-21T20:00:00.000Z')),
    // Out of the open set: archived, completed, deleted two hours ago.
    task('a1', 50, { project_id: 'shelved' }),
    task('c1', 30, { completed: 1, completed_at: NOW - 2 * DAY }),
    task('d1', 5, { deleted_at: NOW - 2 * HOUR }),
    harness.db
      .prepare(
        `INSERT INTO completions(id,task_id,title,completed_at,project_id) VALUES
        ('k1','c1','Synthetic c1',?,''),('k2','w1','Synthetic w1',?,'work'),('k3','w2','Synthetic w2',?,'work')`,
      )
      .bind(NOW - 2 * DAY, NOW - 12 * HOUR, NOW - 10 * DAY),
  ]);
});
afterAll(async () => {
  await harness.dispose();
});

const day = (date: string, scope = 'all') =>
  harness.db.prepare('SELECT * FROM gtd_days WHERE day=? AND scope=?').bind(date, scope).first();

test("a day's counts are written once, after 06:00 local time, with the carried mail", async () => {
  // 05:00 PDT: not yet; the next wake is 06:00.
  expect(await runJobs(env(), NOW - 2 * HOUR)).toBe(Date.parse('2026-10-21T13:00:00Z'));
  expect(await day('2026-10-21')).toBeNull();
  expect(await runJobs(env(), NOW)).toBe(Date.parse('2026-10-22T13:00:00Z'));
  expect(await day('2026-10-21')).toEqual({
    day: '2026-10-21',
    scope: 'all',
    open: 6,
    age_0_7: 3,
    age_8_14: 1,
    age_15_30: 1,
    age_31_plus: 1,
    oldest_days: 40,
    overdue: 2,
    undated: 2,
    created_7d: 3,
    completed_7d: 2,
    closed_1d: 2,
    mail_open: 2,
    complete: 1,
    computed_at: NOW,
  });
  expect(await day('2026-10-21', 'inbox')).toEqual({
    day: '2026-10-21',
    scope: 'inbox',
    open: 4,
    age_0_7: 1,
    age_8_14: 1,
    age_15_30: 1,
    age_31_plus: 1,
    oldest_days: 40,
    overdue: 1,
    undated: 2,
    created_7d: 1,
    completed_7d: 1,
    closed_1d: null,
    mail_open: null,
    complete: 1,
    computed_at: NOW,
  });
  // Later the same day nothing is counted again.
  expect(await runJobs(env(), NOW + 3 * HOUR)).toBe(Date.parse('2026-10-22T13:00:00Z'));
  expect(await day('2026-10-21')).toMatchObject({ computed_at: NOW });
});

test('without Todofy the day is counted with no mail count; the counts read a bounded number of rows', async () => {
  todofy.failures.set('GetMailInbox', 1);
  const { db, metrics } = measuredReads(harness.db);
  await collectDay(env(db), Date.parse('2026-10-22T14:00:00Z'));
  expect(await day('2026-10-22')).toMatchObject({ open: 6, mail_open: null });
  expect(metrics.statements).toBe(1);
  // Every task and completion a few times over (the open set, the week's creations and the day's closures), not
  // once per task.
  expect(metrics.rowsRead).toBeLessThan(20 * 14);
});

test('the Sunday review is created once, from 10:00 local time, in the Inbox, with counts and links', async () => {
  const sunday = Date.parse('2026-10-25T16:00:00Z'); // 09:00 PDT
  expect(await runJobs(env(), sunday)).toBe(Date.parse('2026-10-25T17:00:00Z'));
  expect(await harness.db.prepare('SELECT count(*) AS n FROM weekly_reviews').first()).toEqual({ n: 0 });
  const after = sunday + 90 * 60_000; // 10:30 PDT
  expect(await runJobs(env(), after)).toBe(Date.parse('2026-10-26T13:00:00Z'));
  const review = await harness.db
    .prepare("SELECT r.state,t.title,t.description,t.project_id FROM weekly_reviews r JOIN tasks t ON t.id=r.task_id WHERE r.week='2026-W43'")
    .first<{ state: string; title: string; description: string; project_id: string }>();
  expect(review).toMatchObject({ state: 'created', title: '每周回顾 2026-W43', project_id: '' });
  const body = review?.description ?? '';
  expect(body).toMatch(/^统计 2026-10-25（只含计数）\n/);
  expect(body).toContain('邮件：待处理 3，其中 1–14 天前收到的 2');
  expect(body).toContain(
    '收件箱最老的任务：https://tasks.example.test/?task=i3  https://tasks.example.test/?task=i2  https://tasks.example.test/?task=i1',
  );
  expect(body).not.toMatch(/Synthetic/);
  // No second review that week, however often the object wakes.
  await runJobs(env(), after + HOUR);
  expect(await harness.db.prepare("SELECT count(*) AS n FROM tasks WHERE title LIKE '每周回顾%'").first()).toEqual({ n: 1 });
});

test("the review goes to its routed project, and a week Todofy reviewed keeps Todofy's", async () => {
  await harness.db
    .prepare("INSERT INTO task_inbox_routes(source,project_id,updated_at) VALUES('review','work',1)")
    .run();
  const sunday = Date.parse('2026-11-01T18:30:00Z'); // 10:30 PST
  await runJobs(env(), sunday);
  expect(
    await harness.db
      .prepare("SELECT t.project_id FROM weekly_reviews r JOIN tasks t ON t.id=r.task_id WHERE r.week='2026-W44'")
      .first(),
  ).toEqual({ project_id: 'work' });
  await harness.db
    .prepare("INSERT INTO weekly_reviews(week,state,task_id,created_at) VALUES('2026-W45','unknown','',1)")
    .run();
  expect(await runJobs(env(), Date.parse('2026-11-08T18:30:00Z'))).toBe(Date.parse('2026-11-09T14:00:00Z'));
  expect(await harness.db.prepare("SELECT count(*) AS n FROM tasks WHERE title='每周回顾 2026-W45'").first()).toEqual({
    n: 0,
  });
});

test("a review reads with its completion, and a week without its own task links the week before's", async () => {
  const reviewTask = await harness.db
    .prepare("SELECT task_id FROM weekly_reviews WHERE week='2026-W43'")
    .first<{ task_id: string }>();
  await harness.db
    .prepare('UPDATE tasks SET completed=1,completed_at=? WHERE id=?')
    .bind(Date.parse('2026-10-26T18:00:00Z'), reviewTask?.task_id)
    .run();
  const reviewed = await getWeeklyReview(env(), create(GetWeeklyReviewRequestSchema, { name: 'weeklyReviews/2026-10-19' }));
  expect(reviewed).toMatchObject({ reviewTaskId: reviewTask?.task_id, mailPendingCount: 3, state: WeeklyReview_State.CREATED });
  expect(reviewed.completeTime?.seconds).toBe(BigInt(Date.parse('2026-10-26T18:00:00Z') / 1000));
  const copied = await getWeeklyReview(env(), create(GetWeeklyReviewRequestSchema, { name: 'weeklyReviews/2026-11-02' }));
  expect(copied.state).toBe(WeeklyReview_State.UNKNOWN);
  // The next week has no review yet: it links last Sunday's task, open or not.
  const next = await getWeeklyReview(env(), create(GetWeeklyReviewRequestSchema, { name: 'weeklyReviews/2026-11-09' }));
  expect(next).toMatchObject({ name: 'weeklyReviews/2026-11-09', state: WeeklyReview_State.UNSPECIFIED, reviewTaskId: '' });
  const routed = await getWeeklyReview(env(), create(GetWeeklyReviewRequestSchema, { name: 'weeklyReviews/2026-10-26' }));
  expect(routed.reviewTaskId).not.toBe('');
  todofy.failures.set('GetMailInbox', 1);
  const noMail = await getWeeklyReview(env(), create(GetWeeklyReviewRequestSchema, { name: 'weeklyReviews/2026-10-19' }));
  expect(noMail.mailPendingCount).toBeUndefined();
  await expect(
    getWeeklyReview(env(), create(GetWeeklyReviewRequestSchema, { name: 'weeklyReviews/2026-10-20' })),
  ).rejects.toThrow(/Monday/);
});

test("Home's status arms the jobs object's Alarm and reports the newest day and the review's age", async () => {
  const jobs = await harness.mf.getWorker('tasks-jobs');
  const first = (await (await jobs.fetch('https://jobs.internal/')).json()) as { since: number };
  const again = (await (await jobs.fetch('https://jobs.internal/')).json()) as { since: number };
  expect(again.since).toBe(first.since);
  // The newest counted day, three days old by the real clock.
  const counted = Date.now() - 3 * DAY;
  await harness.db.batch(
    [
      ['all', 9, 1, 3, 4],
      ['inbox', 5, 12, 1, null],
    ].map(([scope, open, oldest, overdue, completed]) =>
      harness.db
        .prepare(
          `INSERT INTO gtd_days(day,scope,open,age_0_7,age_8_14,age_15_30,age_31_plus,oldest_days,overdue,undated,
          completed_7d,computed_at) VALUES('2030-01-01',?,?,0,0,0,0,?,?,0,?,?)`,
        )
        .bind(scope, open, oldest, overdue, completed, counted),
    ),
  );
  const ops = await harness.mf.getWorker('tasks-ops');
  const status = (await (await ops.fetch('https://tasks-ops.internal/')).json()) as {
    health: string;
    counters: Record<string, number>;
    signals: { code: string; severity: string; metrics: Record<string, number> }[];
  };
  expect(status.counters).toMatchObject({ inbox_open: 5, inbox_oldest_days: 12, overdue: 3, completed_7d: 4 });
  expect(status.counters.review_age_days).toBeGreaterThanOrEqual(0);
  expect(status.signals).toEqual([{ code: 'gtd_stale', severity: 'warning', metrics: { age_hours: 72 } }]);
  expect(status.health).toBe('degraded');
});
