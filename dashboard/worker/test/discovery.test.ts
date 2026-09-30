import { describe, expect, it } from 'vitest';
import { BREAKDOWN_UNCLASSIFIED } from '../src/api-types.ts';
import { CF_SCRIPTS_MAX, type Registry } from '../src/api-v2-types.ts';
import { errorLevel, errorPercent, mergeScripts, resourceRows, withBreakdownResources, workerRows, type CfScriptsDoc } from '../src/discovery.ts';
import { REGISTRY } from '../src/registry.ts';
import { parseUsage, type ScriptUsage } from '../src/usage.ts';
import { REALISTIC_USAGE, SYNTHETIC_D1, SYNTHETIC_NS, aiNeurons, graphqlBody, usageWithScripts } from './graphql-fixture.ts';

const T0 = Date.parse('2026-09-29T06:30:00Z');
const MIN = 60_000;
const DAY = 86_400_000;

function usage(script: string, requests: number, extra: Partial<ScriptUsage> = {}): ScriptUsage {
  return { script, requests, errors: 0, subrequests: 0, cpu_p50_us: 500, cpu_p99_us: 900, do_requests: null, do_errors: null, ...extra };
}

function scriptsAt(count: number, now: number): CfScriptsDoc {
  const data = parseUsage(graphqlBody(usageWithScripts(count)), now);
  if (data === null) throw new Error('fixture did not parse');
  return mergeScripts(null, data.scripts, data.workers_truncated, now);
}

describe('mergeScripts (the remembered cf_scripts set)', () => {
  it('records a new script with the hour its requests were first seen', () => {
    const doc = mergeScripts(null, [usage('new-worker', 3)], false, T0);
    expect(doc).toMatchObject({ since: T0, observed_at: T0, day: '2026-09-29', truncated: false });
    expect(doc.scripts).toEqual([
      {
        script: 'new-worker',
        first_seen_day: '2026-09-29',
        last_seen_day: '2026-09-29',
        // The requests happened before 06:30: the 06 hour (tick precision, never "N 分钟前").
        last_active_hour: Date.parse('2026-09-29T06:00:00Z'),
        day: '2026-09-29',
        today: { requests: 3, errors: 0, subrequests: 0, cpu_p50_us: 500, cpu_p99_us: 900, do_requests: null, do_errors: null },
      },
    ]);
  });

  it('moves last_active_hour only when the day count grew, Durable Object invocations included', () => {
    let doc = mergeScripts(null, [usage('cron', 16)], false, T0);
    doc = mergeScripts(doc, [usage('cron', 16)], false, T0 + 30 * MIN);
    doc = mergeScripts(doc, [usage('cron', 16)], false, Date.parse('2026-09-29T09:00:00Z'));
    expect(doc.scripts[0]?.last_active_hour).toBe(Date.parse('2026-09-29T06:00:00Z'));
    doc = mergeScripts(doc, [usage('cron', 16, { do_requests: 4 })], false, Date.parse('2026-09-29T10:00:00Z'));
    // 09:30–10:00 → the 09 hour.
    expect(doc.scripts[0]?.last_active_hour).toBe(Date.parse('2026-09-29T09:00:00Z'));
    expect(doc.since).toBe(T0);
  });

  it('keeps an idle script with zero traffic on a new day, and grows again from zero', () => {
    let doc = mergeScripts(null, [usage('cron', 16), usage('api', 90)], false, T0);
    const nextDay = T0 + DAY;
    doc = mergeScripts(doc, [usage('api', 2)], false, nextDay);
    const cron = doc.scripts.find((r) => r.script === 'cron');
    expect(cron).toMatchObject({ last_seen_day: '2026-09-29', day: '2026-09-30', today: { requests: 0, cpu_p99_us: null }, last_active_hour: Date.parse('2026-09-29T06:00:00Z') });
    // 2 requests on the new day is growth from 0, although fewer than yesterday's 90.
    expect(doc.scripts.find((r) => r.script === 'api')?.last_active_hour).toBe(Date.parse('2026-09-30T06:00:00Z'));
  });

  it('keeps a script missing from an answer on the same day (a truncated page) with its numbers', () => {
    let doc = mergeScripts(null, [usage('a', 5), usage('b', 7)], false, T0);
    doc = mergeScripts(doc, [usage('a', 6)], true, T0 + 30 * MIN);
    expect(doc.truncated).toBe(true);
    expect(doc.scripts.find((r) => r.script === 'b')?.today.requests).toBe(7);
  });

  it(`forgets scripts not seen for 30 days and keeps at most ${String(CF_SCRIPTS_MAX)}`, () => {
    let doc = mergeScripts(null, [usage('old', 1)], false, T0);
    doc = mergeScripts(doc, [usage('fresh', 1)], false, T0 + 29 * DAY);
    expect(doc.scripts.map((r) => r.script)).toEqual(['fresh', 'old']);
    doc = mergeScripts(doc, [usage('fresh', 1)], false, T0 + 30 * DAY);
    expect(doc.scripts.map((r) => r.script)).toEqual(['fresh']);

    const many = Array.from({ length: 120 }, (_, i) => usage(`w-${String(i).padStart(3, '0')}`, 1));
    let big = mergeScripts(null, many.slice(0, 60), false, T0);
    big = mergeScripts(big, many.slice(60), false, T0 + DAY);
    expect(big.scripts).toHaveLength(CF_SCRIPTS_MAX);
    // The 60 seen on the later day all stay; 40 of the earlier day.
    expect(big.scripts.filter((r) => r.last_seen_day === '2026-09-30')).toHaveLength(60);
    expect(JSON.stringify(big).length).toBeLessThan(40_000);
  });
});

describe('the Worker table', () => {
  it('judges the error rate only with at least 20 requests: ≥ 5 % warning, ≥ 20 % critical', () => {
    expect(errorLevel(19, 19)).toBe('ok');
    expect(errorPercent(19, 19)).toBeNull();
    expect(errorLevel(20, 0)).toBe('ok');
    expect(errorLevel(20, 1)).toBe('warning');
    expect(errorPercent(20, 1)).toBe(5);
    expect(errorLevel(100, 4)).toBe('ok');
    expect(errorLevel(100, 20)).toBe('critical');
    expect(errorLevel(0, 0)).toBe('ok');
  });

  it('shows the mockup day: entries joined by the registry, errors first, DO requests on the defining script', () => {
    const rows = workerRows(scriptsAt(5, T0), T0);
    expect(rows.map((r) => [r.script, r.entry, r.requests, r.errors])).toEqual([
      ['todofy', 'todofy', 214, 2],
      ['ziyixi-notion-publish', 'notion-publish', 16, 1],
      ['mail-hero', 'mail-hero', 268, 0],
      ['home', 'home', 118, 0],
      ['todofy-core', 'todofy', 96, 0],
    ]);
    const notion = rows.find((r) => r.script === 'ziyixi-notion-publish');
    // 1 error in 16 requests: too few to judge (样本太少，不判定).
    expect(notion).toMatchObject({ error_percent: null, level: 'ok', cpu_p99_us: 7402, do_requests: null });
    expect(rows.find((r) => r.script === 'todofy-core')).toMatchObject({ do_requests: 632, cpu_p50_us: 1403, subrequests: 37 });
    expect(rows.find((r) => r.script === 'todofy')).toMatchObject({ error_percent: 0.9, level: 'ok', do_requests: null });
  });

  it.each([0, 5, 20])('lists %i scripts, the unregistered ones as 未登记 (entry null)', (count) => {
    const rows = workerRows(scriptsAt(count, T0), T0);
    expect(rows).toHaveLength(count);
    const unregistered = rows.filter((r) => r.entry === null).map((r) => r.script);
    expect(unregistered).toHaveLength(Math.max(0, count - 5));
    for (const script of unregistered) expect(script).toMatch(/^worker-\d\d$/);
    // An unregistered Worker is judged by its own error rate like any other (Q12: no alarm item).
    for (const row of rows) expect(['ok', 'warning', 'critical']).toContain(row.level);
  });

  it('reads yesterday\'s record as no traffic today', () => {
    const rows = workerRows(scriptsAt(5, T0), T0 + DAY);
    expect(rows.every((r) => r.requests === 0 && r.errors === 0 && r.cpu_p99_us === null)).toBe(true);
    expect(rows.every((r) => r.last_seen_day === '2026-09-29')).toBe(true);
    expect(workerRows(null, T0)).toEqual([]);
  });
});

describe('the resource table', () => {
  it('maps registered identifiers and keeps the others as 未登记 with their raw ID', () => {
    const data = parseUsage(graphqlBody(REALISTIC_USAGE), T0);
    const scripts = scriptsAt(5, T0);
    const rows = resourceRows(data?.resources, scripts, T0);
    expect(rows.filter((r) => r.kind === 'd1').map((r) => [r.id, r.resource])).toEqual([
      [SYNTHETIC_D1[0], null],
      [SYNTHETIC_D1[1], null],
    ]);
    expect(rows.find((r) => r.kind === 'r2' && r.id === 'mail-hero-store')).toMatchObject({ resource: 'mail-hero-store', entry: 'mail-hero', class_a: 15_900 });
    expect(rows.find((r) => r.kind === 'r2' && r.id === 'backup-synthetic')).toMatchObject({ resource: null, entry: null });
    // Namespaces are TODO placeholders in the registry: unmapped, so no requests.
    expect(rows.filter((r) => r.kind === 'do').every((r) => r.resource === null && r.requests === null)).toBe(true);
    expect(resourceRows(undefined, scripts, T0)).toEqual([]);
  });

  it('gives a mapped namespace the DO requests of the script defining its class', () => {
    const registry: Registry = {
      ...REGISTRY,
      resources: REGISTRY.resources.map((r) => (r.id === 'todofy-core-do' ? { ...r, match: SYNTHETIC_NS[1] } : r)),
    };
    const data = parseUsage(graphqlBody(REALISTIC_USAGE), T0);
    const rows = resourceRows(data?.resources, scriptsAt(5, T0), T0, registry);
    expect(rows.find((r) => r.id === SYNTHETIC_NS[1])).toEqual({
      kind: 'do',
      id: SYNTHETIC_NS[1],
      resource: 'todofy-core-do',
      entry: 'todofy',
      requests: 632,
      rows_read: 7300,
      rows_written: 610,
    });
  });
});

describe('the quota breakdowns', () => {
  /** The registry with two of its resources matched to the synthetic IDs of REALISTIC_USAGE. */
  const registry: Registry = {
    ...REGISTRY,
    resources: REGISTRY.resources.map((r) =>
      r.id === 'mail-hero-db' ? { ...r, match: SYNTHETIC_D1[0] } : r.id === 'mail-coordinator' ? { ...r, match: SYNTHETIC_NS[0] } : r,
    ),
  };
  const parsed = (extra = {}) => {
    const data = parseUsage(graphqlBody({ ...REALISTIC_USAGE, ...aiNeurons(3), ...extra }), T0);
    if (data === null) throw new Error('fixture did not parse');
    return data.rows;
  };
  const breakdown = (rows: ReturnType<typeof parsed>, id: string) => rows.find((r) => r.id === id)?.breakdown;

  it('joins every D1, DO and R2 item to the registry like the resource table (unknown → null)', () => {
    const stored = parsed();
    const rows = withBreakdownResources(stored, registry);
    for (const id of ['d1_rows_read', 'd1_rows_written', 'd1_storage', 'd1_database_max']) {
      expect(breakdown(rows, id)?.map((item) => [item.name, item.kind, item.resource]), id).toEqual([
        [SYNTHETIC_D1[0], 'd1', 'mail-hero-db'],
        [SYNTHETIC_D1[1], 'd1', null],
      ]);
    }
    for (const id of ['do_duration', 'do_rows_read', 'do_rows_written']) {
      expect(breakdown(rows, id)?.map((item) => [item.name, item.kind, item.resource]), id).toEqual([
        [SYNTHETIC_NS[0], 'do', 'mail-coordinator'],
        [SYNTHETIC_NS[1], 'do', null],
        [SYNTHETIC_NS[2], 'do', null],
      ]);
    }
    for (const id of ['r2_class_a', 'r2_class_b', 'r2_storage']) {
      expect(breakdown(rows, id)?.map((item) => [item.name, item.kind, item.resource]), id).toEqual([
        ['mail-hero-store', 'r2', 'mail-hero-store'],
        ['backup-synthetic', 'r2', null],
      ]);
    }
    expect(breakdown(rows, 'd1_rows_read')?.[0]).toEqual({ name: SYNTHETIC_D1[0], value: 5210, kind: 'd1', resource: 'mail-hero-db' });
    // The same answer for the same identifier as the resource table.
    const table = resourceRows(parseUsage(graphqlBody(REALISTIC_USAGE), T0)?.resources, scriptsAt(5, T0), T0, registry);
    for (const item of rows.flatMap((row) => row.breakdown)) {
      if (item.kind !== undefined) expect(table.find((r) => r.kind === item.kind && r.id === item.name)?.resource, item.name).toBe(item.resource);
    }
  });

  it('leaves script and model items, and rows without a breakdown, as they are; never changes the stored rows', () => {
    const stored = parsed();
    const before = structuredClone(stored);
    const rows = withBreakdownResources(stored, registry);
    for (const id of ['workers_requests', 'do_requests', 'ai_neurons']) {
      expect(breakdown(rows, id), id).toEqual(breakdown(stored, id));
      expect(breakdown(rows, id)?.length, id).toBeGreaterThan(0);
      expect(breakdown(rows, id)?.every((item) => !('kind' in item) && !('resource' in item)), id).toBe(true);
    }
    expect(breakdown(rows, 'do_storage')).toEqual([]);
    expect(stored).toEqual(before);
  });

  it('marks an item without the dimension with its kind and no resource (the page reads 未归类, never 未登记 · unknown)', () => {
    const stored = parsed({
      r2Ops: [
        { actionType: 'PutObject', bucketName: 'mail-hero-store', requests: 10 },
        { actionType: 'PutObject', bucketName: '', requests: 4 },
      ],
    });
    expect(breakdown(withBreakdownResources(stored, registry), 'r2_class_a')).toEqual([
      { name: 'mail-hero-store', value: 10, kind: 'r2', resource: 'mail-hero-store' },
      { name: BREAKDOWN_UNCLASSIFIED, value: 4, kind: 'r2', resource: null },
    ]);
    // Even a registry entry whose match reads "unknown" is never joined to the dimension-less key.
    const trap = { ...registry, resources: registry.resources.map((r) => (r.id === 'mail-hero-db' ? { ...r, match: BREAKDOWN_UNCLASSIFIED } : r)) };
    const d1 = parsed({ d1Databases: [{ id: SYNTHETIC_D1[0], rowsRead: 50, rowsWritten: 2 }, { id: '', rowsRead: 7, rowsWritten: 1 }] });
    expect(breakdown(withBreakdownResources(d1, trap), 'd1_rows_read')?.find((item) => item.name === BREAKDOWN_UNCLASSIFIED)).toEqual({
      name: BREAKDOWN_UNCLASSIFIED,
      value: 7,
      kind: 'd1',
      resource: null,
    });
  });
});
