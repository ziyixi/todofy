/**
 * Synthetic owner-API v2 responses for the UI tests. The registry is the Worker's own public view
 * (worker/src/registry.ts), so the page is tested against the entries, flows and Workers it really
 * serves; app statuses and guard states are the contracts/ops-v1 fixtures. No real account data:
 * resource IDs, numbers and times are made up (magnitudes follow the mockup: ~700 requests a day).
 */
import mailHeroDegraded from '../../../../contracts/ops-v1/fixtures/OpsStatus/mail-hero-degraded.json'
import mailHeroOk from '../../../../contracts/ops-v1/fixtures/OpsStatus/mail-hero-ok.json'
import todofyDegraded from '../../../../contracts/ops-v1/fixtures/OpsStatus/todofy-degraded.json'
import todofyOk from '../../../../contracts/ops-v1/fixtures/OpsStatus/todofy-ok.json'
import shedMailHero from '../../../../contracts/ops-v1/fixtures/GuardState/shed-mail-hero.json'
import shedTodofy from '../../../../contracts/ops-v1/fixtures/GuardState/shed-todofy.json'
import guardNormal from '../../../../contracts/ops-v1/fixtures/GuardState/normal.json'
import type { CanaryRun, CanaryView, GuardState, OpsStatus, QuotaRow, UsageView } from '../../../worker/src/api-types.ts'
import type {
  AttentionItem,
  CloudflareResponse,
  EntryState,
  FlowState,
  FlowsResponse,
  GuardViewV2,
  HomeResponse,
  OpsResponse,
  RegistryResponse,
  ShellFields,
  StageState,
  WorkerRow,
} from '../../../worker/src/api-v2-types.ts'
import { HOME_QUOTA_IDS } from '../../../worker/src/api-v2-types.ts'
import { registryView } from '../../../worker/src/registry.ts'

/** The fixed "now" of every test: 2026-09-29 17:00 UTC (01:00 on 9-30 in Asia/Shanghai). */
export const NOW = new Date('2026-09-29T17:00:00.000Z')
export const BUILD = '0123456789abcdef0123456789abcdef01234567'
/** The last tick: 00:30 on 9-30 in Asia/Shanghai ("今天 00:30"). */
const TICK = '2026-09-29T16:30:04.000Z'

export const status = {
  mailHeroOk: { ...(mailHeroOk as unknown as OpsStatus), generated_at: '2026-09-29T16:30:01.000Z' },
  mailHeroDegraded: mailHeroDegraded as unknown as OpsStatus,
  todofyOk: { ...(todofyOk as unknown as OpsStatus), generated_at: '2026-09-29T16:30:01.000Z' },
  todofyDegraded: todofyDegraded as unknown as OpsStatus,
}
export const guards = {
  normal: guardNormal as unknown as GuardState,
  shedMailHero: shedMailHero as unknown as GuardState,
  shedTodofy: shedTodofy as unknown as GuardState,
}

export function registry(): RegistryResponse {
  return registryView(BUILD)
}

// ---- shell ----------------------------------------------------------------------------------------

export function shell(patch: Partial<ShellFields> = {}): ShellFields {
  return {
    version: 'home-v2',
    generated_at: TICK,
    rev: 7,
    build: BUILD,
    attention: { level: 'ok', items: [], info: [], held: [] },
    badges: { home: 0, flows: 0, cloudflare: 0, ops: 0 },
    refresh: {
      last_tick_at: TICK,
      next_tick_at: '2026-09-29T17:30:00.000Z',
      last_refresh_at: null,
      next_refresh_at: '2026-09-29T16:31:04.000Z',
      refreshed: false,
    },
    ...patch,
  }
}

/** Todofy's Gemini budget at 82 %: the one warning of the mockup. */
export const GEMINI_ITEM: AttentionItem = {
  source: 'todofy',
  code: 'gemini_budget_80',
  severity: 'warning',
  since: '2026-09-29T03:20:00.000Z',
  metrics: { percent: 82.4 },
  target: { view: 'flows', flow: 'mail-to-task', stage: 'consume', entry: 'todofy' },
}

export const UNREACHABLE_ITEM: AttentionItem = {
  source: 'todofy',
  code: 'app_unreachable',
  severity: 'critical',
  since: '2026-09-29T16:00:01.000Z',
  metrics: { consecutive_failures: 2 },
  target: { view: 'ops', entry: 'todofy' },
}

function warned(items: AttentionItem[], badges: Partial<ShellFields['badges']>): Partial<ShellFields> {
  const critical = items.some((item) => item.severity === 'critical')
  const unknown = items.some((item) => item.observed === 'unknown')
  return {
    attention: { level: critical ? 'critical' : unknown ? 'unknown' : 'warning', items, info: [], held: [] },
    badges: { home: 0, flows: 0, cloudflare: 0, ops: 0, ...badges },
  }
}

// ---- quota ----------------------------------------------------------------------------------------

const DOCS = 'https://developers.cloudflare.com/workers/platform/limits/'

function row(partial: Partial<QuotaRow> & Pick<QuotaRow, 'id' | 'period' | 'unit' | 'limit'>): QuotaRow {
  const used = partial.used === undefined ? 0 : partial.used
  return {
    used,
    percent: used === null ? null : Math.round((used / partial.limit) * 1000) / 10,
    projected: null,
    projected_percent: null,
    guard_trigger: partial.period !== 'storage',
    truncated: false,
    breakdown: [],
    source: DOCS,
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
      used: 712,
      projected: 790,
      projected_percent: 0.8,
      breakdown: [
        { name: 'mail-hero', value: 268 },
        { name: 'todofy', value: 214 },
        { name: 'new-worker', value: 3 },
      ],
    }),
    row({ id: 'd1_rows_read', period: 'daily', unit: 'rows', limit: 5_000_000, used: 7_142 }),
    row({ id: 'd1_rows_written', period: 'daily', unit: 'rows', limit: 100_000, used: 486 }),
    row({ id: 'do_requests', period: 'daily', unit: 'requests', limit: 100_000, used: 1_380 }),
    row({ id: 'do_duration', period: 'daily', unit: 'gb_seconds', limit: 13_000, used: 212 }),
    row({ id: 'do_rows_read', period: 'daily', unit: 'rows', limit: 5_000_000, used: 21_400 }),
    row({ id: 'do_rows_written', period: 'daily', unit: 'rows', limit: 100_000, used: 1_920 }),
    // Workers AI: daily but never a guard trigger; synthetic public model IDs.
    row({
      id: 'ai_neurons',
      period: 'daily',
      unit: 'neurons',
      limit: 10_000,
      used: 300,
      projected: 423.5,
      projected_percent: 4.2,
      guard_trigger: false,
      breakdown: [
        { name: '@cf/meta/llama-3.1-8b-instruct', value: 225 },
        { name: '@cf/baai/bge-m3', value: 75 },
      ],
      source: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
    }),
    row({ id: 'r2_class_a', period: 'monthly', unit: 'operations', limit: 1_000_000, used: 18_450 }),
    row({ id: 'r2_class_b', period: 'monthly', unit: 'operations', limit: 10_000_000, used: 61_200 }),
    row({ id: 'd1_storage', period: 'storage', unit: 'bytes', limit: 5_000_000_000, used: 46_200_000 }),
    row({ id: 'd1_database_max', period: 'storage', unit: 'bytes', limit: 500_000_000, used: 38_900_000 }),
    row({ id: 'do_storage', period: 'storage', unit: 'bytes', limit: 5_000_000_000, used: 12_400_000 }),
    row({ id: 'r2_storage', period: 'storage', unit: 'bytes', limit: 10_000_000_000, used: 837_000_000 }),
  ]
  return rows.map((item) => {
    const patch = overrides[item.id]
    if (!patch) return item
    const merged = { ...item, ...patch }
    const percent = merged.used === null ? null : Math.round((merged.used / merged.limit) * 1000) / 10
    return { ...merged, percent: patch.percent !== undefined ? patch.percent : percent }
  })
}


function usage(patch: Partial<UsageView> = {}): UsageView {
  return {
    status: 'ok',
    fetched_at: '2026-09-29T16:30:02.000Z',
    day: '2026-09-29',
    month: '2026-09-01',
    last_error: null,
    last_error_at: null,
    consecutive_failures: 0,
    rows: quotaRows(),
    unclassified_r2_operations: 0,
    ...patch,
  }
}

export const UNAVAILABLE_USAGE: UsageView = {
  status: 'unavailable',
  fetched_at: null,
  day: null,
  month: null,
  last_error: 'http_401',
  last_error_at: '2026-09-29T16:30:02.000Z',
  consecutive_failures: 5,
  rows: [],
  unclassified_r2_operations: 0,
}

// ---- entries (首页) --------------------------------------------------------------------------------

function entry(id: string, patch: Partial<EntryState> = {}): EntryState {
  return {
    id,
    level: 'ok',
    reason: null,
    checked_at: TICK,
    consecutive_failures: 0,
    top_signals: [],
    metric: null,
    ...patch,
  }
}

function entries(patch: Record<string, Partial<EntryState>> = {}): EntryState[] {
  return [
    entry('mail-hero', { metric: { kind: 'counter', name: 'ingest_today_messages', value: 37 }, ...patch['mail-hero'] }),
    entry('todofy', { metric: { kind: 'counter', name: 'received_24h', value: 41 }, ...patch.todofy }),
    entry('flowday', { level: 'link', checked_at: null, ...patch.flowday }),
    entry('website', { metric: { kind: 'latency', ms: 180 }, ...patch.website }),
    entry('notion-publish', { metric: { kind: 'last_active', hour: '2026-09-29T16:00:00.000Z' }, ...patch['notion-publish'] }),
    entry('newsletter', { level: 'unmonitored', checked_at: null, ...patch.newsletter }),
  ]
}

// ---- flows ----------------------------------------------------------------------------------------

function stage(id: string, patch: Partial<StageState> = {}): StageState {
  return {
    id,
    level: 'ok',
    reason: null,
    held: false,
    signals: [],
    counters: [],
    canary: null,
    analytics: null,
    probe: null,
    checked_at: patch.level === 'unmonitored' ? null : TICK,
    ...patch,
  }
}

function canaryRun(partial: Partial<CanaryRun> & Pick<CanaryRun, 'run_id' | 'day' | 'created_at'>): CanaryRun {
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

export const RUN_OK_TODAY = canaryRun({
  run_id: 'canary-2026-09-29',
  day: '2026-09-29',
  created_at: '2026-09-29T16:00:05.000Z',
  queued_at: '2026-09-29T16:00:06.000Z',
  delivered_at: '2026-09-29T16:02:09.000Z',
  completed_at: '2026-09-29T16:06:01.000Z',
  finished_at: '2026-09-29T16:06:02.000Z',
})

export const RUN_FAILED_TODAY = canaryRun({
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

/** 14 scheduled runs, 9-16 … 9-29; the one on 9-22 skipped because Todofy paused processing. */
function recentRuns(today: CanaryRun = RUN_OK_TODAY): CanaryRun[] {
  const runs: CanaryRun[] = [today]
  for (let date = 28; date >= 16; date -= 1) {
    const day = `2026-09-${String(date).padStart(2, '0')}`
    const created = `${day}T16:00:04.000Z`
    runs.push(
      date === 22
        ? canaryRun({
            run_id: `canary-${day}`,
            day,
            created_at: created,
            finished_at: `${day}T16:30:05.000Z`,
            outcome: 'skipped',
            stage: 'consumer',
            code: 'processing_paused',
            delivery: { state: null, attempts: 0, last_http_status: null, error_code: null },
            consumer: { state: null, waiting_code: null, error_code: null },
          })
        : canaryRun({ run_id: `canary-${day}`, day, created_at: created, finished_at: `${day}T16:06:00.000Z` }),
    )
  }
  return runs
}

export function canaryView(patch: Partial<CanaryView> = {}): CanaryView & { id: string } {
  return {
    id: 'mail-todofy',
    enabled: true,
    hour_utc: 16,
    next_scheduled_at: '2026-09-30T16:00:00.000Z',
    today: RUN_OK_TODAY,
    active: null,
    recent: recentRuns(),
    manual_today: 0,
    manual_limit: 3,
    ...patch,
  }
}

function flowStates(options: { geminiWarning?: boolean; todofyDown?: boolean } = {}): FlowState[] {
  const todofyLevel = options.todofyDown ? 'critical' : options.geminiWarning ? 'warning' : 'ok'
  const consumeSignals = options.geminiWarning
    ? [{ code: 'gemini_budget_80', severity: 'warning' as const, since: GEMINI_ITEM.since, metrics: { percent: 82.4 } }]
    : []
  const mailLevel = options.todofyDown ? 'critical' : options.geminiWarning ? 'warning' : 'ok'
  return [
    {
      id: 'mail-to-task',
      level: mailLevel,
      partial: false,
      coverage: { monitored: 5, total: 6 },
      first_issue: options.todofyDown
        ? { stage: 'consume', code: 'unreachable' }
        : options.geminiWarning
          ? { stage: 'consume', code: 'gemini_budget_80' }
          : null,
      freshness: { kind: 'canary', at: RUN_OK_TODAY.finished_at, ok_runs: 13, runs: 14 },
      stages: [
        stage('forward', { level: 'unmonitored' }),
        stage('ingest', {
          counters: [
            { name: 'ingest_today_messages', value: 37 },
            { name: 'capacity_used_bytes', value: 1_288_490_188 },
          ],
          analytics: { requests: 268, errors: 0, error_percent: 0, last_active_hour: '2026-09-29T16:00:00.000Z' },
        }),
        stage('parse', { counters: [{ name: 'jobs_pending', value: 0 }, { name: 'oldest_pending_age_seconds', value: 0 }] }),
        stage('deliver', { canary: 'verified', counters: [{ name: 'delivery_failed', value: 0 }, { name: 'blocked_waiting', value: 0 }] }),
        stage('consume', {
          level: todofyLevel,
          reason: options.todofyDown ? 'unreachable' : options.geminiWarning ? 'gemini_budget_80' : null,
          canary: 'verified',
          signals: consumeSignals,
          counters: [
            { name: 'received_24h', value: 41 },
            { name: 'gemini_calls', value: 43 },
            { name: 'active_events', value: 0 },
          ],
          analytics: { requests: 310, errors: 2, error_percent: 0.6, last_active_hour: '2026-09-29T16:00:00.000Z' },
        }),
        stage('tasks', {
          level: options.todofyDown ? 'critical' : 'ok',
          reason: options.todofyDown ? 'unreachable' : null,
          counters: [{ name: 'attention_events', value: 0 }],
        }),
      ],
      unclassified: [],
      canary: { ...canaryView(), last_ok_at: RUN_OK_TODAY.finished_at },
    },
    {
      id: 'site-publish',
      level: 'ok',
      partial: false,
      coverage: { monitored: 2, total: 3 },
      first_issue: null,
      freshness: { kind: 'activity', at: '2026-09-29T16:00:00.000Z' },
      stages: [
        stage('source', { level: 'unmonitored' }),
        stage('publish', { analytics: { requests: 16, errors: 1, error_percent: null, last_active_hour: '2026-09-29T16:00:00.000Z' } }),
        stage('serve', { probe: { checked_at: TICK, ok: true, http_status: 200, latency_ms: 180 } }),
      ],
      unclassified: [],
      canary: null,
    },
    {
      id: 'daily-newsletter',
      level: 'ok',
      partial: true,
      coverage: { monitored: 1, total: 3 },
      first_issue: null,
      freshness: { kind: 'none' },
      stages: [stage('report'), stage('fetch', { level: 'unmonitored' }), stage('write', { level: 'unmonitored' })],
      unclassified: [],
      canary: null,
    },
    {
      id: 'ops-digest',
      level: 'ok',
      partial: false,
      coverage: { monitored: 3, total: 3 },
      first_issue: null,
      freshness: { kind: 'digest', at: '2026-09-29T15:00:03.000Z', accepted: true },
      stages: [stage('collect'), stage('report'), stage('remind')],
      unclassified: [],
      canary: null,
    },
  ]
}

// ---- Cloudflare -----------------------------------------------------------------------------------

function worker(script: string, entryId: string | null, patch: Partial<WorkerRow> = {}): WorkerRow {
  return {
    script,
    entry: entryId,
    requests: 0,
    errors: 0,
    error_percent: 0,
    level: 'ok',
    subrequests: 0,
    cpu_p50_us: 900,
    cpu_p99_us: 3_000,
    do_requests: null,
    do_errors: null,
    first_seen_day: '2026-09-01',
    last_seen_day: '2026-09-29',
    last_active_hour: '2026-09-29T16:00:00.000Z',
    ...patch,
  }
}

/** The five Workers of the mockup, errors first then requests (the Worker's order). */
export function workerRows(): WorkerRow[] {
  return [
    worker('todofy', 'todofy', { requests: 214, errors: 2, error_percent: 0.9, subrequests: 58, cpu_p50_us: 900, cpu_p99_us: 3_600 }),
    worker('ziyixi-notion-publish', 'notion-publish', {
      requests: 16,
      errors: 1,
      error_percent: null,
      subrequests: 48,
      cpu_p50_us: 2_300,
      cpu_p99_us: 8_400,
      last_active_hour: '2026-09-29T16:00:00.000Z',
    }),
    worker('mail-hero', 'mail-hero', { requests: 268, subrequests: 41, cpu_p50_us: 1_100, cpu_p99_us: 4_800, do_requests: 612, do_errors: 0 }),
    worker('home', 'home', { requests: 118, subrequests: 29, cpu_p50_us: 800, cpu_p99_us: 2_900, do_requests: 136, do_errors: 0 }),
    worker('todofy-core', 'todofy', { requests: 96, subrequests: 37, cpu_p50_us: 1_400, cpu_p99_us: 6_200, do_requests: 632, do_errors: 0 }),
  ]
}

/** `count` unregistered Workers (a busy account), for the table's layout and counts. */
export function manyWorkers(count: number): WorkerRow[] {
  return Array.from({ length: count }, (_, index) =>
    worker(`worker-${String(index + 1).padStart(2, '0')}`, null, { requests: 100 - index, subrequests: index }),
  )
}

function guardView(patch: Partial<GuardViewV2> = {}): GuardViewV2 {
  return {
    desired: { level: 'normal', reason: 'quota_normal', until: null, source: 'auto' },
    override: null,
    thresholds: { shed_percent: 80, clear_percent: 70 },
    apps: {
      'mail-hero': { state: guards.normal, last_call_at: null, last_error: null },
      todofy: { state: guards.normal, last_call_at: null, last_error: null },
    },
    ...patch,
  }
}

export function guardActive(): GuardViewV2 {
  return guardView({
    desired: { level: 'shed', reason: 'quota_d1_rows_read', until: '2026-09-30T00:10:00.000Z', source: 'auto' },
    apps: {
      'mail-hero': { state: guards.shedMailHero, last_call_at: '2026-09-29T14:05:00.000Z', last_error: null },
      todofy: { state: guards.shedTodofy, last_call_at: '2026-09-29T14:05:00.000Z', last_error: 'timeout' },
    },
  })
}

// ---- scenarios ------------------------------------------------------------------------------------

export interface Scenario {
  registry: RegistryResponse
  home: HomeResponse
  flows: FlowsResponse
  cloudflare: CloudflareResponse
  ops: OpsResponse
}

function scenario(
  shellPatch: Partial<ShellFields>,
  parts: {
    entries?: EntryState[]
    flows?: FlowState[]
    usage?: UsageView
    workers?: WorkerRow[]
    guard?: GuardViewV2
    canary?: CanaryView & { id: string }
    apps?: OpsResponse['apps']
  } = {},
): Scenario {
  const base = shell(shellPatch)
  const flows = parts.flows ?? flowStates()
  const use = parts.usage ?? usage()
  const workers = parts.workers ?? workerRows()
  const guard = parts.guard ?? guardView()
  return {
    registry: registry(),
    home: {
      ...base,
      entries: parts.entries ?? entries(),
      flows: flows.map(({ id, level, partial, coverage, first_issue, freshness }) => ({ id, level, partial, coverage, first_issue, freshness })),
      cloudflare: {
        usage_status: use.status,
        fetched_at: use.fetched_at,
        quota: use.rows.filter((item) => HOME_QUOTA_IDS.includes(item.id)),
        workers: workers.length,
        errors_today: workers.reduce((sum, item) => sum + item.errors, 0),
        guard_level: guard.desired.level,
      },
      digest: { last_sent_at: '2026-09-29T15:00:03.000Z', accepted: true },
    },
    flows: { ...base, flows },
    cloudflare: {
      ...base,
      usage: use,
      workers,
      workers_omitted: 0,
      workers_truncated: false,
      resources: [
        { kind: 'd1', id: '8f14e45f-ceea-467a-9575-0000000000aa', resource: null, entry: null, size_bytes: 38_900_000, rows_read: 5_210, rows_written: 318 },
        { kind: 'd1', id: 'c9f0f895-fb98-4b91-9f0a-0000000000bb', resource: null, entry: null, size_bytes: 7_300_000, rows_read: 1_932, rows_written: 168 },
        { kind: 'do', id: '0123456789abcdef0123456789abcdef', resource: null, entry: null, requests: null, rows_read: 4_100, rows_written: 1_020 },
        { kind: 'r2', id: 'mail-hero-store', resource: 'mail-hero-store', entry: 'mail-hero', size_bytes: 781_000_000, class_a: 15_900, class_b: 52_800 },
        { kind: 'r2', id: 'unclassified', resource: null, entry: null, size_bytes: null, class_a: 1_340, class_b: 5_300 },
      ],
      do_storage_bytes: 12_400_000,
      guard,
    },
    ops: {
      ...base,
      guard,
      canary: parts.canary ?? canaryView(),
      digest: {
        items: [],
        enabled: true,
        last_sent_at: '2026-09-29T15:00:03.000Z',
        last_generated_at: '2026-09-29T15:00:00.000Z',
        last_receipt: { stored: true, generated_at: '2026-09-29T15:00:00.000Z', item_count: 0 },
        last_error: null,
        next_due_at: '2026-09-29T21:00:03.000Z',
      },
      apps: parts.apps ?? [
        {
          entry: 'mail-hero',
          reachable: true,
          checked_at: '2026-09-29T16:30:01.000Z',
          error: null,
          consecutive_failures: 0,
          status: status.mailHeroOk,
          status_at: '2026-09-29T16:30:01.000Z',
        },
        {
          entry: 'todofy',
          reachable: true,
          checked_at: '2026-09-29T16:30:01.000Z',
          error: null,
          consecutive_failures: 0,
          status: status.todofyOk,
          status_at: '2026-09-29T16:30:01.000Z',
        },
      ],
    },
  }
}

/** Everything fine. */
export function healthy(): Scenario {
  return scenario({})
}

/** One warning: Todofy's Gemini budget at 82 % (mail flow › Todofy 摘要). */
export function oneWarning(): Scenario {
  return scenario(warned([GEMINI_ITEM], { flows: 1 }), {
    entries: entries({
      todofy: {
        level: 'warning',
        reason: 'gemini_budget_80',
        top_signals: [{ code: 'gemini_budget_80', severity: 'warning', since: GEMINI_ITEM.since }],
      },
    }),
    flows: flowStates({ geminiWarning: true }),
  })
}

/** Todofy's status() failed twice: critical tile, stages and strip; its last good status in 应用详情. */
export function todofyUnreachable(): Scenario {
  const base = scenario(warned([UNREACHABLE_ITEM], { ops: 1 }), {
    entries: entries({ todofy: { level: 'critical', reason: 'unreachable', consecutive_failures: 2, checked_at: TICK } }),
    flows: flowStates({ todofyDown: true }),
  })
  return {
    ...base,
    ops: {
      ...base.ops,
      apps: base.ops.apps.map((app) =>
        app.entry === 'todofy'
          ? { ...app, reachable: false, error: 'timeout', consecutive_failures: 2, status_at: '2026-09-29T15:30:01.000Z' }
          : app,
      ),
    },
  }
}

/**
 * Todofy's status() failed once (no fresh status left) and the site probe answered 503 once: no digest
 * item explains either, so the Worker adds observed items (◆ 未知 first, then ▲ 需关注).
 */
export function observedOnly(): Scenario {
  const items: AttentionItem[] = [
    { source: 'todofy', code: 'unreachable', severity: 'warning', since: null, metrics: {}, target: { view: 'home', entry: 'todofy' }, observed: 'unknown' },
    { source: 'website', code: 'http_status', severity: 'warning', since: null, metrics: {}, target: { view: 'home', entry: 'website' }, observed: 'warning' },
  ]
  return scenario(warned(items, { home: 2 }), {
    entries: entries({
      todofy: { level: 'unknown', reason: 'unreachable', consecutive_failures: 1, checked_at: TICK },
      website: { level: 'warning', reason: 'http_status', consecutive_failures: 1, checked_at: TICK, metric: null },
    }),
  })
}

/** The analytics token is rejected: no usage, no Worker rows. */
export function analyticsUnavailable(): Scenario {
  const item: AttentionItem = {
    source: 'dashboard',
    code: 'usage_unavailable',
    severity: 'warning',
    since: '2026-09-29T14:30:02.000Z',
    metrics: {},
    target: { view: 'cloudflare' },
  }
  return scenario(warned([item], { cloudflare: 1 }), { usage: UNAVAILABLE_USAGE, workers: [] })
}

/** `count` Workers in the table (0: a new account or a quiet day). */
export function withWorkers(count: number): Scenario {
  return scenario({}, { workers: count === 0 ? [] : manyWorkers(count) })
}

/** D1 rows read at 84 %: the auto guard shed both apps (Todofy's setGuard timed out). */
export function guardShed(): Scenario {
  const base = scenario({})
  const guard = guardActive()
  return {
    ...base,
    ops: {
      ...base.ops,
      guard,
      apps: [
        { ...base.ops.apps[0]!, status: { ...status.mailHeroOk, guard: guards.shedMailHero } },
        { ...base.ops.apps[1]!, status: { ...status.todofyOk, guard: guards.shedTodofy } },
      ],
    },
    cloudflare: { ...base.cloudflare, guard },
  }
}

/** Both apps degraded with their contract signals (应用详情). */
export function degradedApps(): Scenario {
  const base = scenario({})
  return {
    ...base,
    ops: {
      ...base.ops,
      apps: [
        { ...base.ops.apps[0]!, status: { ...status.mailHeroDegraded, guard: guards.normal } },
        { ...base.ops.apps[1]!, status: { ...status.todofyDegraded, guard: guards.normal } },
      ],
    },
  }
}

/** A manual canary in progress: queued, waiting for delivery. */
export function canaryActive(): Scenario {
  const base = scenario({})
  const active = canaryRun({
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
  const canary = canaryView({ today: active, active, recent: [active, ...recentRuns().slice(1)], manual_today: 1 })
  return { ...base, ops: { ...base.ops, canary } }
}

/** CANARY_ENABLED=false with a run still in progress (polled to its end); the strip's info item. */
export function canaryDisabled(): Scenario {
  const base = canaryActive()
  const info: AttentionItem = { source: 'dashboard', code: 'canary_disabled', severity: 'info', since: null, metrics: {}, target: { view: 'ops' } }
  const canary = { ...base.ops.canary, enabled: false, next_scheduled_at: null }
  const attention = { ...base.ops.attention, info: [info] }
  const mail = base.flows.flows[0]!
  return {
    ...base,
    home: { ...base.home, attention },
    flows: { ...base.flows, attention, flows: [{ ...mail, canary: { ...canary, last_ok_at: null } }, ...base.flows.flows.slice(1)] },
    ops: { ...base.ops, attention, canary },
  }
}

/** Today's canary failed at delivery with HTTP 503. */
export function canaryFailed(): Scenario {
  const base = scenario({})
  const canary = canaryView({ today: RUN_FAILED_TODAY, recent: recentRuns(RUN_FAILED_TODAY), manual_today: 1 })
  const mail = base.flows.flows[0]!
  const stages = mail.stages.map((item) => (item.id === 'deliver' ? { ...item, level: 'critical' as const, reason: 'canary_failed', canary: 'failed' as const } : item))
  return {
    ...base,
    flows: { ...base.flows, flows: [{ ...mail, level: 'critical', stages, canary: { ...canary, last_ok_at: null } }, ...base.flows.flows.slice(1)] },
    ops: { ...base.ops, canary },
  }
}
