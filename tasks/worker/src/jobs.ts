/**
 * TaskJobs, Tasks' scheduled work: a SQLite Durable Object (binding JOBS, one object `jobs-v1`) that arms its own
 * Alarm; there is no cron. Each wake runs the jobs that are due (schedule.ts), then one step of the weekly backup
 * (backup-runner.ts), and sleeps until the next one: a second later while a backup runs. The GTD day and the review are
 * decided from D1; the object keeps only what it can lose: the time it first ran and the backup's state. Home's
 * Ops.status() calls status(), which arms the Alarm when none is set or brings it forward to a backup due sooner, so a
 * lost Alarm comes back at the next tick and a newly bound bucket gets its first backup then.
 */
import { DurableObject } from 'cloudflare:workers';
import { backupStatus, runBackup, type BackupFacts } from './backup-runner.ts';
import type { Env } from './env.ts';
import { RETRY_MS, runJobs } from './schedule.ts';

export const JOBS_OBJECT = 'jobs-v1';
export interface JobsStatus {
  /** When the object first ran (ms). */
  since: number;
  /** The weekly backup; null without the BACKUPS binding. */
  backup: BackupFacts | null;
}
export class TaskJobs extends DurableObject<Env> {
  /** Arms the Alarm when none is set or a backup is due sooner; Home's tick calls it through Ops.status(). */
  async status(): Promise<JobsStatus> {
    const now = Date.now();
    let since = await this.ctx.storage.get<number>('since');
    if (since === undefined) {
      since = now;
      await this.ctx.storage.put('since', since);
    }
    const backup = await backupStatus(this.env, this.ctx.storage);
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null) await this.ctx.storage.setAlarm(now);
    else if (backup.due < alarm) await this.ctx.storage.setAlarm(Math.max(backup.due, now));
    return { since, backup: backup.facts };
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const settled = (work: Promise<number>) => work.catch(() => now + RETRY_MS);
    // One after the other: the jobs read at most 9 D1 statements and a backup step 30, under Free's 50 together.
    const jobs = await settled(runJobs(this.env, now));
    const backup = await settled(runBackup(this.env, this.ctx.storage, now));
    await this.ctx.storage.setAlarm(Math.min(jobs, backup));
  }
}
