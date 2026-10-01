/**
 * Synthetic HomeState snapshots for the v2 evaluation and view tests (unit suite): the mockup's day
 * (dash-redesign/mockup-content.md), built from the ops-v1 contract fixtures and REALISTIC_USAGE.
 */
import mailHeroOk from '../../../contracts/ops-v1/fixtures/OpsStatus/mail-hero-ok.json';
import todofyOk from '../../../contracts/ops-v1/fixtures/OpsStatus/todofy-ok.json';
import labOk from '../../../contracts/ops-v1/fixtures/OpsStatus/lab-ok.json';
import type { OpsApp, OpsSignal, OpsStatus } from '../src/api-types.ts';
import type { UsageView } from '../src/api-types.ts';
import type { EntryDef, Registry } from '../src/api-v2-types.ts';
import { finish, newRun, type CanaryRecord } from '../src/canary.ts';
import { mergeScripts, type CfScriptsDoc } from '../src/discovery.ts';
import { NO_DIGEST, NO_USAGE, type ProbeDoc, type StatusDoc, type UsageDoc } from '../src/docs.ts';
import type { EvalInput } from '../src/evaluate.ts';
import { REGISTRY } from '../src/registry.ts';
import { parseUsage } from '../src/usage.ts';
import { graphqlBody, usageWithScripts, type SyntheticUsage } from './graphql-fixture.ts';

/** 14:30 UTC, the mockup's last tick. */
export const NOW = Date.parse('2026-09-29T14:30:00Z');
export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/**
 * A synthetic link-only entry (an Access-protected host shown as a link, never probed): the registry
 * has none since the owner removed Flowday from the dashboard (2026-09-30), and the kind stays covered.
 */
export const LINK_ONLY_ENTRY: EntryDef = {
  id: 'link-demo',
  name: 'Link Demo',
  description: '仅链接的测试条目',
  group: 'apps',
  icon: 'calendar-clock',
  accent: 'teal',
  url: 'https://link-demo.ziyixi.science/',
  access: true,
  status: { type: 'link_only' },
  tile_metric: null,
  app_only_signals: [],
  order: 3,
};

/** The registry plus LINK_ONLY_ENTRY. */
export function withLinkOnly(registry: Registry = REGISTRY): Registry {
  return { ...registry, entries: [...registry.entries, LINK_ONLY_ENTRY] };
}

export function status(app: OpsApp, patch: Partial<OpsStatus> = {}, at = NOW - 2 * MIN): StatusDoc {
  const base = (app === 'mail-hero' ? mailHeroOk : app === 'todofy' ? todofyOk : labOk) as OpsStatus;
  return { checked_at: at, ok: true, error: null, consecutive_failures: 0, status: { ...base, ...patch }, status_at: at };
}

export function signal(code: string, severity: OpsSignal['severity'], metrics: Record<string, number> = {}, since?: string): OpsSignal {
  return since === undefined ? { code, severity, metrics } : { code, severity, metrics, since };
}

export function failedStatus(previous: StatusDoc, failures: number, at = NOW - 2 * MIN): StatusDoc {
  return { ...previous, checked_at: at, ok: false, error: 'unavailable', consecutive_failures: failures };
}

export function probe(patch: Partial<ProbeDoc> = {}): ProbeDoc {
  return { checked_at: NOW - MIN, ok: true, http_status: 200, latency_ms: 180, error: null, consecutive_failures: 0, ...patch };
}

/**
 * The remembered scripts after answers at 06:30 (notion-publish's run) and at `now` (everyone else
 * active since), discovery running since two days before.
 */
export function scripts(usage: SyntheticUsage = usageWithScripts(5), now = NOW): CfScriptsDoc {
  const data = parseUsage(graphqlBody(usage), now);
  if (data === null) throw new Error('fixture did not parse');
  const morning = Date.parse('2026-09-29T06:30:00Z');
  const early = mergeScripts(
    { since: now - 2 * DAY, observed_at: morning - 30 * MIN, day: '2026-09-29', truncated: false, scripts: [] },
    data.scripts.filter((s) => s.script === 'ziyixi-notion-publish'),
    false,
    morning,
  );
  return mergeScripts(early, data.scripts, data.workers_truncated, now);
}

/** A finished run of `day` (UTC), started at `hour` (the mockup's today: 09) and done 6 minutes later. */
export function run(day: string, outcome: 'ok' | 'failed' | 'skipped', stage: 'start' | 'delivery' | 'consumer' | null = null, code: string | null = null, hour = 16): CanaryRecord {
  const created = Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00Z`);
  const started = newRun(`canary-${day}`, 'scheduled', created);
  return finish({ ...started, queued_at: created, event_id: '00000000-0000-4000-8000-000000000000' }, outcome, stage, code, created + 6 * MIN);
}

/** 14 daily runs ending yesterday (the mockup's 13 ok and one skip on 9月22日), newest first. */
export function fortnight(latest: CanaryRecord | null = null): CanaryRecord[] {
  const runs: CanaryRecord[] = [];
  for (let i = 1; i <= 14; i++) {
    const day = new Date(NOW - i * DAY).toISOString().slice(0, 10);
    runs.push(day === '2026-09-22' ? run(day, 'skipped', 'consumer', 'processing_paused') : run(day, 'ok'));
  }
  return latest === null ? runs.slice(0, 14) : [latest, ...runs.slice(0, 13)];
}

export function input(patch: Partial<EvalInput> = {}): EvalInput {
  return {
    now: NOW,
    lastTickAt: NOW,
    analyticsConfigured: true,
    statuses: { 'mail-hero': status('mail-hero'), todofy: status('todofy'), lab: status('lab') },
    probes: { website: probe() },
    scripts: scripts(),
    digest: {
      ...NO_DIGEST,
      last_sent_at: Date.parse('2026-09-29T07:00:00Z'),
      last_receipt: { stored: true, generated_at: '2026-09-29T07:00:00.000Z', item_count: 1 },
    },
    canaryRecent: fortnight(),
    ...patch,
  };
}

/** The usage view of a GraphQL answer fetched at `now`. */
export function usageView(usage: SyntheticUsage = usageWithScripts(5), now = NOW): UsageView {
  const data = parseUsage(graphqlBody(usage), now);
  return {
    status: 'ok',
    fetched_at: new Date(now).toISOString(),
    day: '2026-09-29',
    month: '2026-09-01',
    last_error: null,
    last_error_at: null,
    consecutive_failures: 0,
    rows: data?.rows ?? [],
    unclassified_r2_operations: data?.unclassified_r2_operations ?? 0,
  };
}

/** The stored usage document of a GraphQL answer (its per-resource rows). */
export function usageDoc(usage: SyntheticUsage = usageWithScripts(5), now = NOW): UsageDoc {
  const data = parseUsage(graphqlBody(usage), now);
  if (data === null) throw new Error('fixture did not parse');
  return { ...NO_USAGE, fetched_at: now, day: '2026-09-29', month: '2026-09-01', rows: data.rows, resources: data.resources, last_attempt_at: now };
}
