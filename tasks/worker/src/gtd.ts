/**
 * GTD day counts: one row per account day and scope (every project, and the Inbox), which the jobs object (jobs.ts)
 * writes after 06:00 local time and the Sunday review (review.ts) and ops status read. Counts only, never task text.
 * Days copied from Todofy keep their values; Tasks counts every task, so its own rows are complete.
 */
import { localDate } from '@ziyixi/task-dates';
import { accountZone, type Env } from './env.ts';
import { storage } from './errors.ts';
import { mailClient } from './mail.ts';

export const DAY_MS = 86_400_000;

/** A gtd_days row. */
export interface DayRow {
  day: string;
  scope: 'all' | 'inbox';
  open: number;
  age_0_7: number;
  age_8_14: number;
  age_15_30: number;
  age_31_plus: number;
  oldest_days: number;
  overdue: number;
  undated: number;
  created_7d: number | null;
  completed_7d: number | null;
  closed_1d: number | null;
  mail_open: number | null;
  complete: number;
  computed_at: number;
}

/** The Inbox: tasks without a project and those of the Inbox project. */
const INBOX = `inbox(id) AS (SELECT '' UNION ALL SELECT id FROM projects WHERE inbox=1 AND deleted_at IS NULL)`;
/**
 * Both scopes' counts of the day, as one upsert. ?1 is now (ms), ?2 the account day, ?3 the carried mail or NULL. An
 * open task is one the owner sees (not in an archived project); a timed one is overdue once its time has passed, a
 * dated one from the next day on.
 */
const COLLECT = `WITH ${INBOX},
  open AS (SELECT CAST((?1-created_at)/${String(DAY_MS)} AS INTEGER) AS age, due_date='' AS undated,
    CASE WHEN due_datetime<>'' THEN coalesce(unixepoch(due_datetime)*1000<?1, due_date<?2)
      ELSE due_date<>'' AND due_date<?2 END AS late,
    project_id IN (SELECT id FROM inbox) AS in_inbox
    FROM tasks WHERE deleted_at IS NULL AND completed=0 AND project_archived=0),
  scopes(scope) AS (VALUES('all'),('inbox'))
INSERT INTO gtd_days(day,scope,open,age_0_7,age_8_14,age_15_30,age_31_plus,oldest_days,overdue,undated,
  created_7d,completed_7d,closed_1d,mail_open,complete,computed_at)
SELECT ?2,s.scope,count(o.age),coalesce(sum(o.age<=7),0),coalesce(sum(o.age BETWEEN 8 AND 14),0),
  coalesce(sum(o.age BETWEEN 15 AND 30),0),coalesce(sum(o.age>=31),0),coalesce(max(o.age),0),coalesce(sum(o.late),0),
  coalesce(sum(o.undated),0),
  (SELECT count(*) FROM tasks t WHERE t.deleted_at IS NULL AND t.created_at>=?1-${String(7 * DAY_MS)}
    AND (s.scope='all' OR t.project_id IN (SELECT id FROM inbox))),
  (SELECT count(*) FROM completions c WHERE c.completed_at>=?1-${String(7 * DAY_MS)}
    AND (s.scope='all' OR c.project_id IN (SELECT id FROM inbox))),
  CASE WHEN s.scope='all' THEN (SELECT count(*) FROM completions WHERE completed_at>=?1-${String(DAY_MS)})
    +(SELECT count(*) FROM tasks WHERE deleted_at>=?1-${String(DAY_MS)}) END,
  CASE WHEN s.scope='all' THEN ?3 END,1,?1
FROM scopes s LEFT JOIN open o ON s.scope='all' OR o.in_inbox WHERE true GROUP BY s.scope
ON CONFLICT(day,scope) DO UPDATE SET open=excluded.open,age_0_7=excluded.age_0_7,age_8_14=excluded.age_8_14,
  age_15_30=excluded.age_15_30,age_31_plus=excluded.age_31_plus,oldest_days=excluded.oldest_days,
  overdue=excluded.overdue,undated=excluded.undated,created_7d=excluded.created_7d,completed_7d=excluded.completed_7d,
  closed_1d=excluded.closed_1d,mail_open=excluded.mail_open,complete=1,computed_at=excluded.computed_at`;

/** Mail awaiting a decision, and of it what arrived 1 to 14 days ago; undefined when Todofy does not answer. */
export async function mailInbox(env: Env): Promise<{ pending: number; carried: number } | undefined> {
  try {
    const inbox = await mailClient(env).getMailInbox({ name: 'mailInbox' });
    return { pending: inbox.pendingCount, carried: inbox.carryoverCount };
  } catch {
    return undefined;
  }
}

/** Writes the account day's counts (both scopes, one statement); the mail count is NULL when Todofy is out. */
export async function collectDay(env: Env, now: number): Promise<string> {
  const day = localDate(now, accountZone(env));
  const mail = await mailInbox(env);
  await storage(() => env.DB.prepare(COLLECT).bind(now, day, mail?.carried ?? null).run());
  return day;
}
