import { WorkerEntrypoint } from 'cloudflare:workers';
import { create } from '@ziyixi/proto/protobuf';
import { GuardLevel, Health, OpsStatusSchema, Severity } from '@ziyixi/proto/ops/v1/ops_pb';
import type * as wire from '@ziyixi/proto/ops/v1/ops_wire';
import { toWire } from '@ziyixi/proto/wire-json';
import { backupOps } from './backup-runner.ts';
import type { Env } from './env.ts';
import type { DayRow } from './gtd.ts';
import { JOBS_OBJECT, type JobsStatus } from './jobs.ts';

const HOUR_MS = 3_600_000;
/** gtd_stale: no day counted for this long. */
export const GTD_STALE_MS = 48 * HOUR_MS;
/** review_overdue: no review completed for more than this many days. */
export const REVIEW_OVERDUE_DAYS = 10;
/** Signals come critical first, then by code (ops-v1). */
const rank = (severity: Severity) => (severity === Severity.CRITICAL ? 0 : severity === Severity.WARNING ? 1 : 2);

/**
 * Read-only Home status: the change feed, the newest GTD day's counts and the review's age, from one D1 batch, and the
 * weekly backup's facts from the jobs object. A quiet task list is healthy. Reading it also arms the jobs object's
 * Alarm when none is set (jobs.ts), the one write ops-v1 allows.
 */
export class Ops extends WorkerEntrypoint<Env> implements wire.OpsService {
  async status(): Promise<wire.OpsStatus> {
    const now = Date.now();
    const base = {
      version: 'ops-v1',
      app: 'tasks',
      generatedAt: new Date(now).toISOString(),
      modes: { maintenance: false },
      guard: { level: GuardLevel.NORMAL },
      capabilities: [],
      uiUrl: `https://${this.env.PUBLIC_HOST}/`,
    };
    try {
      const db = this.env.DB;
      const [jobs, [latest, days, reviews]] = await Promise.all([
        this.jobs(),
        db.batch([
          db.prepare('SELECT sequence FROM changes ORDER BY sequence DESC LIMIT 1'),
          db.prepare('SELECT * FROM gtd_days WHERE day=(SELECT max(day) FROM gtd_days)'),
          db.prepare(
            `SELECT min(r.created_at) AS first,max(coalesce(r.completed_at,CASE WHEN t.completed=1 THEN t.completed_at END))
            AS done FROM weekly_reviews r LEFT JOIN tasks t ON t.id=r.task_id AND t.deleted_at IS NULL`,
          ),
        ]),
      ]);
      const counters: Record<string, number> = {
        database_ready: 1,
        change_sequence: (latest?.results[0] as { sequence: number } | undefined)?.sequence ?? 0,
      };
      const signals: { code: string; severity: Severity; metrics: Record<string, number> }[] = [];
      const rows = (days?.results ?? []) as unknown as DayRow[];
      const all = rows.find((row) => row.scope === 'all');
      const inbox = rows.find((row) => row.scope === 'inbox');
      if (inbox) Object.assign(counters, { inbox_open: inbox.open, inbox_oldest_days: inbox.oldest_days });
      if (all) counters.overdue = all.overdue;
      if (all?.completed_7d !== null && all?.completed_7d !== undefined) counters.completed_7d = all.completed_7d;
      // Without a counted day, the stale time runs from the jobs object's first run.
      const counted = all?.computed_at ?? jobs?.since;
      if (counted !== undefined && now - counted > GTD_STALE_MS)
        signals.push({
          code: 'gtd_stale',
          severity: Severity.WARNING,
          metrics: { age_hours: Math.floor((now - counted) / HOUR_MS) },
        });
      const review = reviews?.results[0] as { first: number | null; done: number | null } | undefined;
      const reviewed = review?.done ?? review?.first ?? null;
      if (reviewed !== null) {
        const age = Math.max(Math.floor((now - reviewed) / (24 * HOUR_MS)), 0);
        counters.review_age_days = age;
        if (age > REVIEW_OVERDUE_DAYS)
          signals.push({ code: 'review_overdue', severity: Severity.INFO, metrics: { days: age } });
      }
      const backup = backupOps(jobs?.backup ?? null, now);
      Object.assign(counters, backup.counters);
      signals.push(...backup.signals);
      signals.sort((a, b) => rank(a.severity) - rank(b.severity) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
      return toWire(
        OpsStatusSchema,
        create(OpsStatusSchema, {
          ...base,
          health: signals.some((signal) => signal.severity !== Severity.INFO) ? Health.DEGRADED : Health.OK,
          signals,
          counters,
          ...(backup.lastBackupAt ? { lastBackupAt: backup.lastBackupAt } : {}),
        }),
      );
    } catch {
      return toWire(
        OpsStatusSchema,
        create(OpsStatusSchema, {
          ...base,
          health: Health.DOWN,
          counters: {},
          signals: [{ code: 'status_unavailable', severity: Severity.CRITICAL }],
        }),
      );
    }
  }

  setGuard(): Promise<wire.GuardState> {
    return Promise.reject(new Error('invalid_input'));
  }

  /** The jobs object's status, which arms its Alarm; undefined when it does not answer (the status still does). */
  private async jobs(): Promise<JobsStatus | undefined> {
    try {
      return await this.env.JOBS.get(this.env.JOBS.idFromName(JOBS_OBJECT)).status();
    } catch {
      return undefined;
    }
  }
}
