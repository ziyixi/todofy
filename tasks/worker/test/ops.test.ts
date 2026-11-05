import { afterEach, expect, test, vi } from 'vitest';
import { Health, Severity } from '@ziyixi/proto/ops/v1/ops_pb';
import type { Env } from '../src/env.ts';
import type { DayRow } from '../src/gtd.ts';
import type { JobsStatus } from '../src/jobs.ts';
import { GTD_STALE_MS, Ops, REVIEW_OVERDUE_DAYS } from '../src/ops.ts';

const NOW = Date.parse('2030-04-15T12:00:00Z');
const DAY_MS = 24 * 3_600_000;

function sampleDayRow(overrides: Partial<DayRow> = {}): DayRow {
  return {
    day: '2030-04-15',
    scope: 'all',
    open: 8,
    age_0_7: 4,
    age_8_14: 2,
    age_15_30: 1,
    age_31_plus: 1,
    oldest_days: 35,
    overdue: 2,
    undated: 3,
    created_7d: 5,
    completed_7d: 6,
    closed_1d: 1,
    mail_open: 0,
    complete: 1,
    computed_at: NOW - 3_600_000,
    ...overrides,
  };
}

interface FakeOpsOptions {
  sequence?: number;
  days?: DayRow[];
  review?: { first: number | null; done: number | null };
  jobsStatus?: JobsStatus | Error;
  dbError?: boolean;
}

function makeOps(options: FakeOpsOptions = {}): Ops {
  const env = {
    PUBLIC_HOST: 'tasks.example.test',
    JOBS: {
      idFromName: (name: string) => name as unknown as DurableObjectId,
      get: () => ({
        status: () => {
          if (options.jobsStatus instanceof Error) return Promise.reject(options.jobsStatus);
          return Promise.resolve(
            options.jobsStatus ?? {
              since: NOW - 3_600_000,
              backup: { lastSuccessAt: NOW - 3_600_000, lastError: '' },
            },
          );
        },
      }),
    },
    DB: {
      prepare: (sql: string) => ({ sql }),
      batch: () => {
        if (options.dbError) return Promise.reject(new Error('d1 unavailable'));
        return Promise.resolve([
          { results: options.sequence !== undefined ? [{ sequence: options.sequence }] : [] },
          { results: options.days ?? [] },
          { results: options.review ? [options.review] : [] },
        ]);
      },
    },
  } as unknown as Env;
  return new Ops({} as ExecutionContext, env);
}

afterEach(() => {
  vi.useRealTimers();
});

test('Ops.status emits gtd_stale when GTD_STALE_MS is exceeded and review_overdue when REVIEW_OVERDUE_DAYS is exceeded', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);

  const staleComputedAt = NOW - GTD_STALE_MS - 2 * 3_600_000; // 50 hours ago
  const overdueReviewedAt = NOW - (REVIEW_OVERDUE_DAYS + 3) * DAY_MS; // 13 days ago

  const ops = makeOps({
    sequence: 42,
    days: [
      sampleDayRow({ scope: 'all', computed_at: staleComputedAt, overdue: 4, completed_7d: 9 }),
      sampleDayRow({ scope: 'inbox', open: 3, oldest_days: 12 }),
    ],
    review: { first: overdueReviewedAt - DAY_MS, done: overdueReviewedAt },
  });

  const status = await ops.status();
  expect(status.health).toBe(Health[Health.DEGRADED]);
  expect(status.counters).toMatchObject({
    database_ready: 1,
    change_sequence: 42,
    inbox_open: 3,
    inbox_oldest_days: 12,
    overdue: 4,
    completed_7d: 9,
    review_age_days: 13,
  });
  expect(status.signals).toEqual([
    {
      code: 'gtd_stale',
      severity: Severity[Severity.WARNING],
      metrics: { age_hours: 50 },
    },
    {
      code: 'review_overdue',
      severity: Severity[Severity.INFO],
      metrics: { days: 13 },
    },
  ]);
});

test('Ops.status falls back to jobs.since for gtd_stale, review.first for review_overdue, and reports healthy when fresh', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);

  const staleJobsSince = NOW - GTD_STALE_MS - 3_600_000; // 49 hours ago
  const staleOps = makeOps({
    days: [],
    review: { first: NOW - (REVIEW_OVERDUE_DAYS + 1) * DAY_MS, done: null },
    jobsStatus: {
      since: staleJobsSince,
      backup: { lastSuccessAt: NOW - 3_600_000, lastError: '' },
    },
  });
  const degraded = await staleOps.status();
  expect(degraded.signals?.map((s) => s.code)).toEqual(['gtd_stale', 'review_overdue']);

  // Fresh state with only review_overdue (INFO) or no signals stays Health.OK even if JOBS RPC throws
  const healthyOps = makeOps({
    days: [sampleDayRow({ scope: 'all', computed_at: NOW - 3_600_000 })],
    review: { first: NOW - 2 * DAY_MS, done: NOW - 2 * DAY_MS },
    jobsStatus: new Error('jobs DO restarting'),
  });
  const healthy = await healthyOps.status();
  expect(healthy.health).toBe(Health[Health.OK]);
  expect(healthy.counters?.review_age_days).toBe(2);
});

test('Ops.status returns DOWN on D1 error and setGuard rejects with invalid_input', async () => {
  const downOps = makeOps({ dbError: true });
  const status = await downOps.status();
  expect(status.health).toBe(Health[Health.DOWN]);
  expect(status.signals).toEqual([{ code: 'status_unavailable', severity: Severity[Severity.CRITICAL] }]);

  await expect(downOps.setGuard()).rejects.toThrow('invalid_input');
});
