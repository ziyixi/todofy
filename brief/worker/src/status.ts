/**
 * The pipeline's state for the owner (ServiceStatus) and for Home (ops-v1, ops-status.ts): the mode, the switches, the
 * key's state, the costs of the day and the month against the budget, the sources' health and the day's counts. Codes,
 * counts, costs and times only.
 */
import { Mode, ServiceStatus_KeyState, ServiceStatusSchema, type ServiceStatus } from '@ziyixi/proto/brief/ui/v1/status_pb';
import { create } from '@ziyixi/proto/protobuf';
import { daySpend, monthSpend, rejectedState } from './claude.ts';
import { modelRouter, mailSettings, mode, type Env } from './env.ts';
import { healthCounts, type HealthCounts } from './health.ts';
import { KEY_STATES, MODES, time } from './model.ts';
import type { Registry } from './registry.ts';
import { localDate, monthOf } from './schedule.ts';
import { readSettings } from './settings.ts';
import type { RunRow, Store } from './store.ts';

export interface StatusNumbers {
  readonly mode: ReturnType<typeof mode>;
  readonly paused: boolean;
  readonly keyState: 'not_configured' | 'ok' | 'rejected';
  readonly rejectedStatus: number;
  readonly rejectedType: string;
  readonly mailConfigured: boolean;
  readonly todayCost: number;
  readonly monthCost: number;
  readonly reserved: number;
  readonly budget: number;
  readonly health: HealthCounts;
  readonly todayItems: number;
  readonly todayScreened: number;
  readonly todayRefused: number;
  readonly todayNeurons: number;
  readonly run: RunRow | null;
}

/** The numbers both statuses read. The rejected state is shown as stored (a new key or build lifts it at the next call). */
export function statusNumbers(store: Store, registry: Registry, env: Env, now: number): StatusNumbers {
  const day = localDate(now);
  const { spent, reserved } = monthSpend(store, monthOf(day));
  const settings = readSettings(store);
  const usage = store.usage(day);
  const rejected = rejectedState(store);
  const run = store.one<RunRow>(`SELECT * FROM runs WHERE done = 0 ORDER BY issue DESC LIMIT 1`) ?? null;
  return {
    mode: mode(env),
    paused: settings.paused,
    keyState: modelRouter(env) === null || store.getMeta('model_configured') === '0' ? 'not_configured' : rejected === null ? 'ok' : 'rejected',
    rejectedStatus: rejected?.status ?? 0,
    rejectedType: rejected?.type ?? '',
    mailConfigured: mailSettings(env) !== null,
    todayCost: daySpend(store, day),
    monthCost: spent,
    reserved,
    budget: settings.monthlyBudgetUsd,
    health: healthCounts(store, registry, now),
    todayItems: usage.items,
    todayScreened: usage.screened,
    todayRefused: usage.refused,
    todayNeurons: usage.neurons,
    run,
  };
}

const cents = (usd: number): number => Math.round(usd * 10_000) / 10_000;

export function serviceStatus(store: Store, registry: Registry, env: Env, now: number, build: string, alarmAt: number | null): ServiceStatus {
  const numbers = statusNumbers(store, registry, env, now);
  return create(ServiceStatusSchema, {
    name: 'serviceStatus',
    mode: MODES.value(numbers.mode) ?? Mode.UNSPECIFIED,
    paused: numbers.paused,
    keyState: KEY_STATES.value(numbers.keyState) ?? ServiceStatus_KeyState.UNSPECIFIED,
    mailConfigured: numbers.mailConfigured,
    nextAlarmTime: time(alarmAt),
    currentIssue: numbers.run === null ? '' : `issues/${numbers.run.issue}`,
    currentStep: numbers.run?.step ?? '',
    todayCostUsd: cents(numbers.todayCost),
    monthCostUsd: cents(numbers.monthCost),
    monthlyBudgetUsd: numbers.budget,
    okSourceCount: numbers.health.ok,
    failingSourceCount: numbers.health.failing + numbers.health.paused,
    todayItemCount: numbers.todayItems,
    todayNeurons: Math.round(numbers.todayNeurons * 10) / 10,
    recentErrorCodes: store.recentErrors(),
    build,
    rejectedStatus: numbers.rejectedStatus,
    rejectedErrorType: numbers.rejectedType,
    staleSourceCount: numbers.health.stale,
    todayCandidateCount: numbers.todayScreened,
    reservedUsd: cents(numbers.reserved),
  });
}
