/**
 * TaskJobs, Tasks' scheduled work: a SQLite Durable Object (binding JOBS, one object `jobs-v1`) that arms its own
 * Alarm; there is no cron. Each wake runs the jobs that are due (schedule.ts) and sleeps until the next one. They are
 * decided from D1, so the object keeps only what it can lose: the time it first ran. Home's Ops.status() calls
 * status(), which arms the Alarm when none is set, so a lost Alarm comes back at the next tick.
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.ts';
import { RETRY_MS, runJobs } from './schedule.ts';

export const JOBS_OBJECT = 'jobs-v1';
export interface JobsStatus {
  /** When the object first ran (ms). */
  since: number;
}
export class TaskJobs extends DurableObject<Env> {
  /** Arms the Alarm when none is set; Home's tick calls it through Ops.status(). */
  async status(): Promise<JobsStatus> {
    let since = await this.ctx.storage.get<number>('since');
    if (since === undefined) {
      since = Date.now();
      await this.ctx.storage.put('since', since);
    }
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
    return { since };
  }

  override async alarm(): Promise<void> {
    let next: number;
    try {
      next = await runJobs(this.env, Date.now());
    } catch {
      next = Date.now() + RETRY_MS;
    }
    await this.ctx.storage.setAlarm(next);
  }
}
