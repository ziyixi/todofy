/**
 * LinksBackup (../../docs/backup.md): the daily backup's clock, a SQLite Durable Object (binding BACKUP_ALARM, one
 * object `backup-v1`) whose Alarm runs one step of backup-runner.ts and sets the next from the time it answers: STEP_MS
 * later while a job runs, else the next start (05:25 UTC, or a failed job's retry). There is no cron trigger. The
 * object stores nothing but its Alarm; the backup's state stays in the bucket's state.json.
 *
 * Every Alarm sets the next one, so once armed the backup depends on no other app. arm() sets the first and brings
 * back a lost one: Ops.status() calls it at each of Home's ticks, and the owner's first request under /_/ in each
 * isolate calls it too. With `due` (no backup state yet: the release that bound the bucket, or a lost state.json) it
 * brings the Alarm forward to now, so the first job starts at once.
 */
import { DurableObject } from 'cloudflare:workers';
import { runBackup, STEP_MS } from './backup-runner.ts';
import type { Env } from './env.ts';

export const BACKUP_OBJECT = 'backup-v1';

export class LinksBackup extends DurableObject<Env> {
  /** Arms the Alarm at now when none is set, or when `due` and it is later; answers when it fires. */
  async arm(due = false): Promise<number> {
    const now = Date.now();
    const at = await this.ctx.storage.getAlarm();
    if (at !== null && (!due || at <= now)) return at;
    await this.ctx.storage.setAlarm(now);
    return now;
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    let run: { step: string; next: number | null; error?: string };
    try {
      run = await runBackup(this.env, now);
    } catch (error) {
      // R2 did not answer for state.json: the step runs again STEP_MS later.
      run = { step: 'error', next: now + STEP_MS, error: error instanceof Error ? error.name : 'unknown' };
    }
    // Without the bucket (local dev) nothing is scheduled; arm() starts again once it is bound.
    if (run.next !== null) await this.ctx.storage.setAlarm(Math.max(run.next, now + 1000));
    // One line per run, once the next Alarm is set: the step, the next time and an error's name, never content.
    console.log(JSON.stringify({ backup: run }));
  }
}

/** Arms the backup's Alarm (LinksBackup.arm) when the object is bound. */
export async function armBackup(env: Env, due = false): Promise<void> {
  const namespace = env.BACKUP_ALARM;
  if (namespace) await namespace.get(namespace.idFromName(BACKUP_OBJECT)).arm(due);
}
