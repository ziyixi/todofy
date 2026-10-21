/**
 * When Tasks' jobs run (the jobs object, jobs.ts, wakes for them):
 *
 * - the day's GTD counts (gtd.ts), from 06:00 local time, once a day;
 * - the weekly review (review.ts), on Sunday from 10:00 local time, once a week.
 *
 * Both are idempotent and decided from D1: the day's row and the week's review. A failed job is retried 10 minutes
 * later.
 */
import { addDays, localDate, zonedInstant } from '@ziyixi/task-dates';
import { accountZone, type Env } from './env.ts';
import { storage } from './errors.ts';
import { collectDay } from './gtd.ts';
import { createReview, isoWeek } from './review.ts';

/** Local hours: the day's counts from COLLECT_HOUR, Sunday's review from REVIEW_HOUR. */
export const COLLECT_HOUR = 6;
export const REVIEW_HOUR = 10;
export const RETRY_MS = 10 * 60_000;

/** The instant of a local hour of a day; an hour a DST change skips is the next one. */
function atLocal(day: string, hour: number, zone: string): number {
  const wall = (value: number) => `${day}T${String(value).padStart(2, '0')}:00:00`;
  try {
    return Date.parse(zonedInstant(wall(hour), zone));
  } catch {
    return Date.parse(zonedInstant(wall(hour + 1), zone));
  }
}
/** Sunday is 0. */
const weekday = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();

/** Runs the jobs due at `now` and answers when the next one is due. */
export async function runJobs(env: Env, now: number): Promise<number> {
  const zone = accountZone(env);
  const today = localDate(now, zone);
  const [counted, reviewed] = await storage(() =>
    env.DB.batch([
      env.DB.prepare("SELECT 1 FROM gtd_days WHERE day=? AND scope='all'").bind(today),
      env.DB.prepare('SELECT 1 FROM weekly_reviews WHERE week=?').bind(isoWeek(today)),
    ]),
  );

  let collect = atLocal(today, COLLECT_HOUR, zone);
  if (counted?.results.length) collect = atLocal(addDays(today, 1), COLLECT_HOUR, zone);
  else if (now >= collect) {
    try {
      await collectDay(env, now);
      collect = atLocal(addDays(today, 1), COLLECT_HOUR, zone);
    } catch {
      collect = now + RETRY_MS;
    }
  }

  const sunday = weekday(today) === 0;
  let review = atLocal(addDays(today, (7 - weekday(today)) % 7), REVIEW_HOUR, zone);
  if (sunday && (reviewed?.results.length || now >= review)) {
    review = atLocal(addDays(today, 7), REVIEW_HOUR, zone);
    if (!reviewed?.results.length) {
      try {
        await createReview(env, now);
      } catch {
        review = now + RETRY_MS;
      }
    }
  }
  return Math.min(collect, review);
}
