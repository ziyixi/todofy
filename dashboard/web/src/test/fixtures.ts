/**
 * Synthetic owner-API responses for the UI tests. App statuses and guard states are the
 * contracts/ops-v1 fixtures themselves, so the page is tested against what the apps really return.
 * No real account data: IDs, names and numbers are made up.
 */
import mailHeroDegraded from '../../../../contracts/ops-v1/fixtures/OpsStatus/mail-hero-degraded.json'
import mailHeroOk from '../../../../contracts/ops-v1/fixtures/OpsStatus/mail-hero-ok.json'
import todofyDegraded from '../../../../contracts/ops-v1/fixtures/OpsStatus/todofy-degraded.json'
import todofyOk from '../../../../contracts/ops-v1/fixtures/OpsStatus/todofy-ok.json'
import shedMailHero from '../../../../contracts/ops-v1/fixtures/GuardState/shed-mail-hero.json'
import shedTodofy from '../../../../contracts/ops-v1/fixtures/GuardState/shed-todofy.json'
import guardNormal from '../../../../contracts/ops-v1/fixtures/GuardState/normal.json'
import type {
  CanaryRun,
  GuardState,
  OpsStatus,
  OverviewResponse,
  QuotaRow,
} from '../../../worker/src/api-types.ts'

/** The fixed "now" of every test: 2026-09-29 17:00 UTC (01:00 on 9-30 in Asia/Shanghai). */
export const NOW = new Date('2026-09-29T17:00:00.000Z')

const status = {
  mailHeroOk: mailHeroOk as unknown as OpsStatus,
  mailHeroDegraded: mailHeroDegraded as unknown as OpsStatus,
  todofyOk: todofyOk as unknown as OpsStatus,
  todofyDegraded: todofyDegraded as unknown as OpsStatus,
}
const guards = {
  normal: guardNormal as unknown as GuardState,
  shedMailHero: shedMailHero as unknown as GuardState,
  shedTodofy: shedTodofy as unknown as GuardState,
}

const DOCS = {
  workers: 'https://developers.cloudflare.com/workers/platform/limits/#daily-requests',
  d1: 'https://developers.cloudflare.com/d1/platform/pricing/',
  d1Limits: 'https://developers.cloudflare.com/d1/platform/limits/',
  do: 'https://developers.cloudflare.com/durable-objects/platform/pricing/',
  r2: 'https://developers.cloudflare.com/r2/pricing/',
}

function row(partial: Partial<QuotaRow> & Pick<QuotaRow, 'id' | 'period' | 'unit' | 'limit'>): QuotaRow {
  const used = partial.used === undefined ? 0 : partial.used
  const percent = used === null ? null : Math.round((used / partial.limit) * 1000) / 10
  return {
    used,
    percent,
    projected: null,
    projected_percent: null,
    guard_trigger: partial.period !== 'storage',
    truncated: false,
    breakdown: [],
    source: DOCS.workers,
    ...partial,
  }
}

export function quotaRows(overrides: Partial<Record<QuotaRow['id'], Partial<QuotaRow>>> = {}): QuotaRow[] {
  const rows: QuotaRow[] = [
    row({
      id: 'workers_requests',
      period: 'daily',
      unit: 'requests',
      limit: 100_000,
      used: 12_345,
      projected: 17_428,
      projected_percent: 17.4,
      breakdown: [
        { name: 'mail-hero', value: 6_000 },
        { name: 'todofy', value: 5_200 },
        { name: 'home', value: 1_145 },
      ],
    }),
    row({ id: 'd1_rows_read', period: 'daily', unit: 'rows', limit: 5_000_000, used: 1_200_000, source: DOCS.d1 }),
    row({ id: 'd1_rows_written', period: 'daily', unit: 'rows', limit: 100_000, used: 4_000, source: DOCS.d1 }),
    row({ id: 'do_requests', period: 'daily', unit: 'requests', limit: 100_000, used: 3_000, source: DOCS.do }),
    row({ id: 'do_duration', period: 'daily', unit: 'gb_seconds', limit: 13_000, used: 410.5, source: DOCS.do }),
    row({ id: 'do_rows_read', period: 'daily', unit: 'rows', limit: 5_000_000, used: 90_000, source: DOCS.do }),
    row({ id: 'do_rows_written', period: 'daily', unit: 'rows', limit: 100_000, used: 2_500, source: DOCS.do }),
    row({ id: 'r2_class_a', period: 'monthly', unit: 'operations', limit: 1_000_000, used: 120_000, source: DOCS.r2 }),
    row({ id: 'r2_class_b', period: 'monthly', unit: 'operations', limit: 10_000_000, used: 350_000, source: DOCS.r2 }),
    row({ id: 'd1_storage', period: 'storage', unit: 'bytes', limit: 5_000_000_000, used: 250_000_000, source: DOCS.d1Limits }),
    row({ id: 'd1_database_max', period: 'storage', unit: 'bytes', limit: 500_000_000, used: 180_000_000, source: DOCS.d1Limits }),
    row({ id: 'do_storage', period: 'storage', unit: 'bytes', limit: 5_000_000_000, used: null, source: DOCS.do }),
    row({ id: 'r2_storage', period: 'storage', unit: 'bytes', limit: 10_000_000_000, used: 1_300_000_000, source: DOCS.r2 }),
  ]
  return rows.map((item) => {
    const patch = overrides[item.id]
    if (!patch) return item
    const merged = { ...item, ...patch }
    const percent =
      patch.percent !== undefined ? patch.percent : merged.used === null ? null : Math.round((merged.used / merged.limit) * 1000) / 10
    return { ...merged, percent }
  })
}

function run(partial: Partial<CanaryRun> & Pick<CanaryRun, 'run_id' | 'day' | 'created_at'>): CanaryRun {
  return {
    kind: 'scheduled',
    phase: 'done',
    outcome: 'ok',
    stage: null,
    code: null,
    event_id: '3f1d2c4b-5a69-4e7f-8a1b-2c3d4e5f6a7b',
    queued_at: null,
    delivered_at: null,
    completed_at: null,
    finished_at: null,
    deadline_at: new Date(new Date(partial.created_at).getTime() + 2 * 3600_000).toISOString(),
    delivery: { state: 'delivered', attempts: 1, last_http_status: 204, error_code: null },
    consumer: { state: 'ok', waiting_code: null, error_code: null },
    polls: 3,
    start_code: null,
    last_call_error: null,
    ...partial,
  }
}

export const RUN_OK_TODAY = run({
  run_id: 'canary-2026-09-29',
  day: '2026-09-29',
  created_at: '2026-09-29T16:00:05.000Z',
  queued_at: '2026-09-29T16:00:06.000Z',
  delivered_at: '2026-09-29T16:00:09.000Z',
  completed_at: '2026-09-29T16:00:31.000Z',
  finished_at: '2026-09-29T16:30:02.000Z',
})

export const RUN_FAILED_TODAY = run({
  run_id: 'canary-2026-09-29',
  day: '2026-09-29',
  created_at: '2026-09-29T14:00:05.000Z',
  queued_at: '2026-09-29T14:00:06.000Z',
  finished_at: '2026-09-29T16:00:10.000Z',
  outcome: 'failed',
  stage: 'delivery',
  code: 'http_503',
  delivery: { state: 'failed', attempts: 4, last_http_status: 503, error_code: 'http_503' },
  consumer: { state: null, waiting_code: null, error_code: null },
  polls: 5,
})

const RUN_SKIPPED = run({
  run_id: 'canary-2026-09-27',
  day: '2026-09-27',
  created_at: '2026-09-27T16:00:04.000Z',
  finished_at: '2026-09-27T18:00:05.000Z',
  outcome: 'skipped',
  stage: 'start',
  code: 'send_paused',
  event_id: null,
  delivery: { state: null, attempts: 0, last_http_status: null, error_code: null },
  consumer: { state: null, waiting_code: null, error_code: null },
})

const RUN_OK_YESTERDAY = run({
  run_id: 'canary-2026-09-28',
  day: '2026-09-28',
  created_at: '2026-09-28T16:00:03.000Z',
  queued_at: '2026-09-28T16:00:04.000Z',
  delivered_at: '2026-09-28T16:00:07.000Z',
  completed_at: '2026-09-28T16:00:40.000Z',
  finished_at: '2026-09-28T16:30:01.000Z',
})

/** Everything fine: both apps ok, low usage, today's canary ok, empty digest. */
export function healthyOverview(): OverviewResponse {
  return {
    version: 'home-v1',
    generated_at: '2026-09-29T16:30:04.000Z',
    overall: { level: 'ok', items: [] },
    apps: {
      'mail-hero': {
        app: 'mail-hero',
        url: 'https://mail.example.com/',
        reachable: true,
        checked_at: '2026-09-29T16:30:01.000Z',
        error: null,
        consecutive_failures: 0,
        status: { ...status.mailHeroOk, generated_at: '2026-09-29T16:30:01.000Z' },
        status_at: '2026-09-29T16:30:01.000Z',
      },
      todofy: {
        app: 'todofy',
        url: 'https://todofy.example.com/',
        reachable: true,
        checked_at: '2026-09-29T16:30:01.000Z',
        error: null,
        consecutive_failures: 0,
        status: { ...status.todofyOk, generated_at: '2026-09-29T16:30:01Z' },
        status_at: '2026-09-29T16:30:01.000Z',
      },
    },
    usage: {
      status: 'ok',
      fetched_at: '2026-09-29T16:30:02.000Z',
      day: '2026-09-29',
      month: '2026-09-01',
      last_error: null,
      last_error_at: null,
      consecutive_failures: 0,
      rows: quotaRows(),
      unclassified_r2_operations: 0,
    },
    guard: {
      desired: { level: 'normal', reason: 'quota_normal', until: null, source: 'auto' },
      override: null,
      thresholds: { shed_percent: 80, clear_percent: 70 },
      apps: {
        'mail-hero': { state: guards.normal, last_call_at: null, last_error: null },
        todofy: { state: guards.normal, last_call_at: null, last_error: null },
      },
    },
    canary: {
      enabled: true,
      hour_utc: 16,
      next_scheduled_at: '2026-09-30T16:00:00.000Z',
      today: RUN_OK_TODAY,
      active: null,
      recent: [RUN_OK_TODAY, RUN_OK_YESTERDAY, RUN_SKIPPED],
      manual_today: 0,
      manual_limit: 3,
    },
    digest: {
      items: [],
      enabled: true,
      last_sent_at: '2026-09-29T12:00:03.000Z',
      last_generated_at: '2026-09-29T12:00:00.000Z',
      last_receipt: { stored: true, generated_at: '2026-09-29T12:00:00.000Z', item_count: 0 },
      last_error: null,
      next_due_at: '2026-09-29T18:00:03.000Z',
    },
    refresh: {
      last_tick_at: '2026-09-29T16:30:04.000Z',
      last_refresh_at: null,
      next_refresh_at: '2026-09-29T16:31:04.000Z',
      refreshed: false,
    },
    build: '0123456789abcdef0123456789abcdef01234567',
  }
}

/** Both apps degraded with their fixture signals; the digest carries them. */
export function degradedOverview(): OverviewResponse {
  const base = healthyOverview()
  return {
    ...base,
    overall: {
      level: 'critical',
      items: [
        { source: 'mail-hero', code: 'endpoint_blocked', severity: 'critical' },
        { source: 'todofy', code: 'backup_stale', severity: 'critical' },
        { source: 'mail-hero', code: 'capacity_70', severity: 'warning' },
      ],
    },
    apps: {
      'mail-hero': { ...base.apps['mail-hero'], status: { ...status.mailHeroDegraded, guard: guards.normal } },
      todofy: { ...base.apps.todofy, status: { ...status.todofyDegraded, guard: guards.normal } },
    },
    digest: {
      ...base.digest,
      items: [
        {
          source: 'mail-hero',
          code: 'endpoint_blocked',
          severity: 'critical',
          since: '2026-09-29T10:02:11.000Z',
          metrics: { waiting_deliveries: 3, current_blocked: 1 },
        },
        { source: 'todofy', code: 'backup_stale', severity: 'critical', since: '2026-09-28T10:00:00Z', metrics: { age_seconds: 792000 } },
        { source: 'mail-hero', code: 'capacity_70', severity: 'warning', since: '2026-09-28T22:40:00.000Z', metrics: { percent: 72 } },
      ],
      last_receipt: { stored: true, generated_at: '2026-09-29T16:30:04.000Z', item_count: 3 },
    },
  }
}

/** Todofy's status() keeps failing; the card shows the last good status. */
export function unreachableOverview(): OverviewResponse {
  const base = healthyOverview()
  return {
    ...base,
    overall: { level: 'critical', items: [{ source: 'todofy', code: 'app_unreachable', severity: 'critical' }] },
    apps: {
      ...base.apps,
      todofy: {
        ...base.apps.todofy,
        reachable: false,
        checked_at: '2026-09-29T16:30:01.000Z',
        error: 'timeout',
        consecutive_failures: 3,
        status: status.todofyOk,
        status_at: '2026-09-29T15:30:01.000Z',
      },
    },
    digest: {
      ...base.digest,
      items: [
        {
          source: 'todofy',
          code: 'app_unreachable',
          severity: 'critical',
          since: '2026-09-29T15:30:01.000Z',
          metrics: { consecutive_failures: 3 },
        },
      ],
    },
  }
}

/** D1 rows read at 84 %: the auto guard shed both apps. */
export function guardActiveOverview(): OverviewResponse {
  const base = healthyOverview()
  return {
    ...base,
    overall: {
      level: 'warning',
      items: [
        { source: 'cloudflare', code: 'd1_rows_read_high', severity: 'warning' },
        { source: 'dashboard', code: 'guard_shed', severity: 'warning' },
      ],
    },
    apps: {
      'mail-hero': { ...base.apps['mail-hero'], status: { ...status.mailHeroOk, guard: guards.shedMailHero } },
      todofy: { ...base.apps.todofy, status: { ...status.todofyOk, guard: guards.shedTodofy } },
    },
    usage: {
      ...base.usage,
      rows: quotaRows({
        d1_rows_read: { used: 4_200_000, projected: 6_000_000, projected_percent: 120, truncated: true },
      }),
    },
    guard: {
      ...base.guard,
      desired: { level: 'shed', reason: 'quota_d1_rows_read', until: '2026-09-30T00:10:00.000Z', source: 'auto' },
      apps: {
        'mail-hero': { state: guards.shedMailHero, last_call_at: '2026-09-29T14:05:00.000Z', last_error: null },
        todofy: { state: guards.shedTodofy, last_call_at: '2026-09-29T14:05:00.000Z', last_error: 'timeout' },
      },
    },
  }
}

/** Today's canary failed at delivery with HTTP 503. */
export function canaryFailedOverview(): OverviewResponse {
  const base = healthyOverview()
  return {
    ...base,
    overall: { level: 'critical', items: [{ source: 'dashboard', code: 'canary_not_delivered', severity: 'critical' }] },
    canary: {
      ...base.canary,
      today: RUN_FAILED_TODAY,
      recent: [RUN_FAILED_TODAY, RUN_OK_YESTERDAY, RUN_SKIPPED],
      manual_today: 1,
    },
  }
}

/** The analytics token is rejected: usage unavailable, nothing to show. */
export function analyticsUnavailableOverview(): OverviewResponse {
  const base = healthyOverview()
  return {
    ...base,
    overall: { level: 'warning', items: [{ source: 'dashboard', code: 'usage_unavailable', severity: 'warning' }] },
    usage: {
      status: 'unavailable',
      fetched_at: null,
      day: null,
      month: null,
      last_error: 'http_401',
      last_error_at: '2026-09-29T16:30:02.000Z',
      consecutive_failures: 5,
      rows: [],
      unclassified_r2_operations: 0,
    },
  }
}

/** A canary in progress: queued and waiting for delivery. */
export function canaryActiveOverview(): OverviewResponse {
  const base = healthyOverview()
  const active = run({
    run_id: 'canary-manual-20260929T165500Z',
    kind: 'manual',
    day: '2026-09-29',
    created_at: '2026-09-29T16:55:00.000Z',
    queued_at: '2026-09-29T16:55:01.000Z',
    phase: 'delivering',
    outcome: null,
    delivery: { state: 'pending', attempts: 1, last_http_status: 503, error_code: 'http_503' },
    consumer: { state: null, waiting_code: null, error_code: null },
    polls: 1,
  })
  return {
    ...base,
    canary: { ...base.canary, today: active, active, recent: [active, ...base.canary.recent], manual_today: 1 },
  }
}

/** CANARY_ENABLED=false with a run still in progress (it is polled to its end); the banner's info item. */
export function canaryDisabledOverview(): OverviewResponse {
  const base = canaryActiveOverview()
  return {
    ...base,
    overall: { level: 'ok', items: [{ source: 'dashboard', code: 'canary_disabled', severity: 'info' }] },
    canary: { ...base.canary, enabled: false, next_scheduled_at: null },
  }
}
