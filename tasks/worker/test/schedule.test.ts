import { beforeEach, expect, test, vi } from 'vitest';
import * as taskDates from '@ziyixi/task-dates';
import type { Env } from '../src/env.ts';
import * as gtdModule from '../src/gtd.ts';
import * as reviewModule from '../src/review.ts';
import { COLLECT_HOUR, RETRY_MS, REVIEW_HOUR, runJobs } from '../src/schedule.ts';

vi.mock('@ziyixi/task-dates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ziyixi/task-dates')>();
  return {
    ...actual,
    zonedInstant: vi.fn(actual.zonedInstant),
  };
});

vi.mock('../src/gtd.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/gtd.ts')>();
  return {
    ...actual,
    collectDay: vi.fn(),
  };
});

vi.mock('../src/review.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/review.ts')>();
  return {
    ...actual,
    createReview: vi.fn(),
  };
});

function fakeEnv(counted: boolean, reviewed: boolean, zone = 'America/Los_Angeles'): Env {
  const makeStmt = () => ({
    bind: () => ({}),
  });
  return {
    TIMEZONE: zone,
    DB: {
      prepare: () => makeStmt(),
      batch: () =>
        Promise.resolve([
          { results: counted ? [{ 1: 1 }] : [] },
          { results: reviewed ? [{ 1: 1 }] : [] },
        ]),
    } as unknown as D1Database,
  } as unknown as Env;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

test('atLocal falls back to hour + 1 when a DST transition skips the target local hour', async () => {
  const realZonedInstant = await vi
    .importActual<typeof import('@ziyixi/task-dates')>('@ziyixi/task-dates')
    .then((m) => m.zonedInstant);
  const zonedSpy = vi.mocked(taskDates.zonedInstant).mockImplementation((wall: string, zone: string) => {
    if (wall === `2030-03-10T0${String(COLLECT_HOUR)}:00:00`) {
      throw new taskDates.TaskDateError('This local time does not exist in the selected timezone');
    }
    return realZonedInstant(wall, zone);
  });

  // 2030-03-10 at 05:00 local (before collect hour), not yet counted: atLocal('2030-03-10', 6, zone) catches and uses hour 7.
  const now = Date.parse(realZonedInstant('2030-03-10T05:00:00', 'America/Los_Angeles'));
  const next = await runJobs(fakeEnv(false, true), now);

  expect(zonedSpy).toHaveBeenCalledWith('2030-03-10T06:00:00', 'America/Los_Angeles');
  expect(zonedSpy).toHaveBeenCalledWith('2030-03-10T07:00:00', 'America/Los_Angeles');
  expect(next).toBe(Date.parse(realZonedInstant('2030-03-10T07:00:00', 'America/Los_Angeles')));
});

test('runJobs schedules RETRY_MS when collectDay or Sunday createReview fails, and advances when they succeed', async () => {
  const realZonedInstant = await vi
    .importActual<typeof import('@ziyixi/task-dates')>('@ziyixi/task-dates')
    .then((m) => m.zonedInstant);
  vi.mocked(taskDates.zonedInstant).mockImplementation(realZonedInstant);

  // Sunday 2030-04-14 at 11:00 UTC (past both 06:00 and 10:00 in UTC)
  const sundayNow = Date.parse('2030-04-14T11:00:00Z');

  // 1. collectDay throws -> collect scheduled at sundayNow + RETRY_MS
  vi.mocked(gtdModule.collectDay).mockRejectedValueOnce(new Error('collect failed'));
  vi.mocked(reviewModule.createReview).mockResolvedValueOnce(undefined);
  const retryCollect = await runJobs(fakeEnv(false, false, 'UTC'), sundayNow);
  expect(retryCollect).toBe(sundayNow + RETRY_MS);

  // 2. collectDay succeeds, createReview throws -> review scheduled at sundayNow + RETRY_MS
  vi.mocked(gtdModule.collectDay).mockResolvedValueOnce(undefined);
  vi.mocked(reviewModule.createReview).mockRejectedValueOnce(new Error('review failed'));
  const retryReview = await runJobs(fakeEnv(false, false, 'UTC'), sundayNow);
  expect(retryReview).toBe(sundayNow + RETRY_MS);

  // 3. Both succeed -> next due is Monday 2030-04-15 at COLLECT_HOUR (06:00 UTC), which is earlier than next Sunday REVIEW_HOUR
  vi.mocked(gtdModule.collectDay).mockResolvedValueOnce(undefined);
  vi.mocked(reviewModule.createReview).mockResolvedValueOnce(undefined);
  const nextMondayCollect = await runJobs(fakeEnv(false, false, 'UTC'), sundayNow);
  expect(nextMondayCollect).toBe(
    Date.parse(`2030-04-15T${String(COLLECT_HOUR).padStart(2, '0')}:00:00Z`),
  );
  expect(REVIEW_HOUR).toBe(10);
});
