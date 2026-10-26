/**
 * The weekly review (proto/tasks/ui/v1/gtd.proto): one task per ISO week, which the jobs object (jobs.ts) creates on
 * Sunday from 10:00 local time. Its description is counts, trends against a week before, what stands out and links,
 * never a task title (ported from Todofy's core/gtd.py review_body). The review row and its task are written in one
 * batch, and the row's primary key refuses a second review of a week. Reviews copied from Todofy keep their states.
 */
import { encodePageToken } from '@ziyixi/proto/page-token';
import { create } from '@ziyixi/proto/protobuf';
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { WeeklyReview_State, WeeklyReviewSchema, type WeeklyReview } from '@ziyixi/proto/tasks/ui/v1/gtd_pb';
import {
  ListWeeklyReviewsResponseSchema,
  type GetWeeklyReviewRequest,
  type ListWeeklyReviewsRequest,
} from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';
import { addDays, localDate, validDate } from '@ziyixi/task-dates';
import { accountZone, type Env } from './env.ts';
import { invalid, storage } from './errors.ts';
import { DAY_MS, mailInbox, textCursor, type DayRow } from './gtd.ts';
import { routedProject } from './inbox-routes.ts';

const MAX_REVIEWS = 13;
/** The oldest Inbox tasks the review links to. */
const OLDEST_LINKS = 3;
const MAX_BODY_BYTES = 8192;

// ---- weeks -----------------------------------------------------------------------------------------------------

/** The ISO week (2026-W43) of a calendar day. */
export function isoWeek(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  // The week's Thursday decides its year.
  const thursday = new Date(date.getTime() + (3 - ((date.getUTCDay() + 6) % 7)) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1;
  return `${String(year)}-W${String(week).padStart(2, '0')}`;
}
/** The Monday of an ISO week. */
export function weekMonday(week: string): string {
  const january4 = `${week.slice(0, 4)}-01-04`;
  const firstMonday = addDays(january4, -((new Date(`${january4}T00:00:00Z`).getUTCDay() + 6) % 7));
  return addDays(firstMonday, (Number(week.slice(6)) - 1) * 7);
}
/** weeklyReviews/{monday}: the week it names. */
function namedWeek(name: string): string {
  const monday = name.startsWith('weeklyReviews/') ? name.slice('weeklyReviews/'.length) : '';
  if (!validDate(monday) || new Date(`${monday}T00:00:00Z`).getUTCDay() !== 1) invalid('Name a week by its Monday');
  return isoWeek(monday);
}

// ---- reads -----------------------------------------------------------------------------------------------------

interface ReviewRow {
  week: string;
  state: 'created' | 'unknown' | 'failed';
  task_id: string;
  created_at: number;
  completed_at: number | null;
}
/** A review with its completion: copied, or its task's while the task exists. */
const REVIEWS = `SELECT r.week,r.state,r.task_id,r.created_at,
  coalesce(r.completed_at,CASE WHEN t.completed=1 THEN t.completed_at END) AS completed_at
  FROM weekly_reviews r LEFT JOIN tasks t ON t.id=r.task_id AND t.deleted_at IS NULL`;
const STATES = {
  created: WeeklyReview_State.CREATED,
  unknown: WeeklyReview_State.UNKNOWN,
  failed: WeeklyReview_State.FAILED,
} as const;

function reviewMessage(row: ReviewRow): WeeklyReview {
  return create(WeeklyReviewSchema, {
    name: `weeklyReviews/${weekMonday(row.week)}`,
    state: STATES[row.state],
    reviewTaskId: row.task_id,
    createTime: timestampFromMs(row.created_at),
    ...(row.completed_at === null ? {} : { completeTime: timestampFromMs(row.completed_at) }),
  });
}
/** One week's review and the mail awaiting a decision; without a task of its own, the week before's task. */
export async function getWeeklyReview(env: Env, input: GetWeeklyReviewRequest): Promise<WeeklyReview> {
  const week = namedWeek(input.name);
  const previous = isoWeek(addDays(weekMonday(week), -7));
  const [rows, mail] = await Promise.all([
    storage(() => env.DB.prepare(`${REVIEWS} WHERE r.week IN (?,?)`).bind(week, previous).all<ReviewRow>()),
    mailInbox(env),
  ]);
  const current = rows.results.find((row) => row.week === week);
  const before = rows.results.find((row) => row.week === previous);
  const review = current ? reviewMessage(current) : create(WeeklyReviewSchema, { name: input.name });
  review.name = input.name;
  review.reviewTaskId = review.reviewTaskId || before?.task_id || '';
  if (mail) review.mailPendingCount = mail.pending;
  return review;
}
/** The weeks with a review, newest first; the token is the last week shown. */
export async function listWeeklyReviews(db: D1Database, input: ListWeeklyReviewsRequest) {
  if (!Number.isInteger(input.pageSize) || input.pageSize < 0) invalid('Invalid page size');
  const size = Math.min(input.pageSize || MAX_REVIEWS, MAX_REVIEWS);
  const after = input.pageToken ? textCursor(input.pageToken) : '9999-W99';
  if (!/^\d{4}-W\d\d$/.test(after)) invalid('Invalid page token');
  const rows = await storage(() =>
    db.prepare(`${REVIEWS} WHERE r.week<? ORDER BY r.week DESC LIMIT ?`).bind(after, size + 1).all<ReviewRow>(),
  );
  const page = rows.results.slice(0, size);
  return create(ListWeeklyReviewsResponseSchema, {
    weeklyReviews: page.map(reviewMessage),
    nextPageToken: rows.results.length > size ? encodePageToken(page.at(-1)?.week ?? '', {}) : '',
  });
}

// ---- the Sunday review -----------------------------------------------------------------------------------------

/** What the review's description shows: counts, trends, the oldest Inbox tasks' IDs and links. */
export interface ReviewFacts {
  /** The newest counted day at the review, with the rows of the day a week before it. */
  day: string | undefined;
  all: DayRow | undefined;
  inbox: DayRow | undefined;
  allBefore: DayRow | undefined;
  inboxBefore: DayRow | undefined;
  mail: { pending: number; carried: number } | undefined;
  /** When the last review was completed (ms). */
  lastDone: number | undefined;
  oldestInbox: string[];
  origin: string;
}

export function reviewTitle(week: string): string {
  return `每周回顾 ${week}`;
}
function trend(now: number, before: number | null | undefined): string {
  if (before === null || before === undefined) return '';
  const delta = now - before;
  return delta ? `（上周 ${String(before)}，${delta > 0 ? '+' : ''}${String(delta)}）` : `（上周 ${String(before)}，持平）`;
}
/** At most two lines on what the numbers ask for this week. */
function focus({ all, inbox, allBefore, inboxBefore }: ReviewFacts): string[] {
  if (!all) return [];
  const lines: string[] = [];
  if (inbox?.age_31_plus) lines.push(`收件箱里超过 30 天的 ${String(inbox.age_31_plus)} 项：逐个决定 做 / 委派 / 删除`);
  const grown = allBefore ? all.overdue - allBefore.overdue : 0;
  if (grown > 0) lines.push(`逾期比上周多 ${String(grown)} 项：重排日期，或删掉不再做的`);
  else if (all.overdue && !lines.length) lines.push(`逾期 ${String(all.overdue)} 项：重排日期，或删掉不再做的`);
  if (inbox && inboxBefore && inbox.open > inboxBefore.open && lines.length < 2)
    lines.push(`收件箱比上周多 ${String(inbox.open - inboxBefore.open)} 项：先清空到 0`);
  return lines.slice(0, 2);
}
const count = (value: number | null | undefined) => (value === null || value === undefined ? '不可用' : String(value));

/** The review task's description, cut to 8 KiB. */
export function reviewBody(facts: ReviewFacts, now: number): string {
  const { all, inbox, allBefore, inboxBefore } = facts;
  const lines: string[] = [];
  if (!all || !facts.day) {
    lines.push('统计：本周没有可用的 GTD 统计（只含计数，稍后可在 Tasks 的 GTD 页查看）。');
  } else {
    lines.push(`统计 ${facts.day}（只含计数${all.complete ? '' : '；任务过多，统计不完整'}）`);
    if (inbox)
      lines.push(
        `收件箱：开放 ${String(inbox.open)}${trend(inbox.open, inboxBefore?.open)}；` +
          `最老 ${String(inbox.oldest_days)} 天${trend(inbox.oldest_days, inboxBefore?.oldest_days)}；` +
          `0–7 天 ${String(inbox.age_0_7)} · 8–14 天 ${String(inbox.age_8_14)} · 15–30 天 ${String(inbox.age_15_30)}` +
          ` · >30 天 ${String(inbox.age_31_plus)}`,
      );
    lines.push(
      `全部项目：开放 ${String(all.open)}${trend(all.open, allBefore?.open)}` +
        ` · 逾期 ${String(all.overdue)}${trend(all.overdue, allBefore?.overdue)}` +
        ` · 无日期 ${String(all.undated)}${trend(all.undated, allBefore?.undated)}`,
    );
    const completed =
      all.completed_7d === null ? '不可用' : `${String(all.completed_7d)}${trend(all.completed_7d, allBefore?.completed_7d)}`;
    lines.push(`近 7 天：新建 ${count(all.created_7d)} · 完成 ${completed}`);
  }
  lines.push(
    facts.mail
      ? `邮件：待处理 ${String(facts.mail.pending)}，其中 1–14 天前收到的 ${String(facts.mail.carried)}`
      : '邮件：不可用',
  );
  if (facts.oldestInbox.length)
    lines.push(`收件箱最老的任务：${facts.oldestInbox.map((id) => `${facts.origin}/?task=${id}`).join('  ')}`);
  lines.push(
    facts.lastDone === undefined
      ? '上次回顾：尚无完成记录'
      : `上次回顾：${new Date(facts.lastDone).toISOString().slice(0, 10)} 完成（${String(Math.max(Math.floor((now - facts.lastDone) / DAY_MS), 0))} 天前）`,
  );
  lines.push(...focus(facts).map((line) => `本周重点：${line}`));
  lines.push('回顾上一周，安排本周。步骤：清空收件箱 → 看逾期与无日期 → 看项目与等待 → 安排本周');
  lines.push(`周回顾：${facts.origin}/?review=1   GTD：${facts.origin}/#/gtd`);
  const body = `${lines.join('\n')}\n`;
  const bytes = new TextEncoder().encode(body);
  return bytes.length <= MAX_BODY_BYTES ? body : new TextDecoder().decode(bytes.slice(0, MAX_BODY_BYTES)).replace(/�$/, '');
}

/** The facts of the week's review: one batch of reads, and Todofy's mail counts. */
async function reviewFacts(env: Env, now: number): Promise<ReviewFacts> {
  const today = localDate(now, accountZone(env));
  const db = env.DB;
  const [days, done, oldest] = await storage(() =>
    db.batch([
      db.prepare('SELECT * FROM gtd_days WHERE day BETWEEN ? AND ?').bind(addDays(today, -14), today),
      db.prepare(`SELECT max(completed_at) AS at FROM (${REVIEWS})`),
      db
        .prepare(
          `WITH inbox(id) AS (SELECT '' UNION ALL SELECT id FROM projects WHERE inbox=1 AND deleted_at IS NULL)
          SELECT id FROM tasks WHERE deleted_at IS NULL AND completed=0 AND project_archived=0 AND parent_id=''
          AND project_id IN (SELECT id FROM inbox) ORDER BY created_at,id LIMIT ${String(OLDEST_LINKS)}`,
        ),
    ]),
  );
  const rows = (days?.results ?? []) as unknown as DayRow[];
  const find = (day: string | undefined, scope: string) => rows.find((row) => row.day === day && row.scope === scope);
  const day = rows
    .filter((row) => row.scope === 'all')
    .map((row) => row.day)
    .sort()
    .at(-1);
  const before = day && addDays(day, -7);
  return {
    day,
    all: find(day, 'all'),
    inbox: find(day, 'inbox'),
    allBefore: find(before, 'all'),
    inboxBefore: find(before, 'inbox'),
    mail: await mailInbox(env),
    lastDone: (done?.results[0] as { at: number | null } | undefined)?.at ?? undefined,
    oldestInbox: ((oldest?.results ?? []) as { id: string }[]).map((row) => row.id),
    origin: `https://${env.PUBLIC_HOST}`,
  };
}

/**
 * Creates the review of the ISO week of the account day `now` is in: its row and its task, in the routed project
 * (`review`) or the Inbox, in one batch. A week that has a review keeps it: 'exists'.
 */
export async function createReview(env: Env, now: number): Promise<'created' | 'exists'> {
  const week = isoWeek(localDate(now, accountZone(env)));
  const facts = await reviewFacts(env, now);
  const project = await routedProject(env.DB, 'review');
  const taskId = crypto.randomUUID();
  const db = env.DB;
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO tasks(id,title,description,project_id,sort_order,created_at,updated_at) VALUES(?,?,?,?,
          (SELECT COALESCE(MAX(sort_order),0)+1 FROM tasks WHERE project_id=? AND parent_id='' AND section_id='' AND deleted_at IS NULL),?,?)`,
        )
        .bind(taskId, reviewTitle(week), reviewBody(facts, now), project, project, now, now),
      db
        .prepare("INSERT INTO weekly_reviews(week,state,task_id,created_at) VALUES(?,'created',?,?)")
        .bind(week, taskId, now),
    ]);
    return 'created';
  } catch (error) {
    if (String(error).includes('UNIQUE constraint')) return 'exists';
    throw error;
  }
}
