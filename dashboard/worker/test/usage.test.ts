import { describe, expect, it, vi } from 'vitest';
import design from '../../docs/design.md?raw';
import { QUOTA_RESOURCES, type QuotaRow } from '../src/api-types.ts';
import { ALLOWANCES } from '../src/limits.ts';
import limitsDoc from '../../docs/limits.md?raw';
import {
  GRAPHQL_URL,
  R2_ASSUMED_CLASS_A,
  R2_CLASS_A,
  R2_CLASS_B,
  R2_FREE,
  USAGE_QUERY,
  fetchUsage,
  parseUsage,
  projection,
  usageVariables,
  type FetchLike,
} from '../src/usage.ts';
import { REALISTIC_USAGE, SYNTHETIC_D1, SYNTHETIC_NS, graphqlBody, usageWithScripts } from './graphql-fixture.ts';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const TOKEN = 'synthetic-analytics-token-000000000000';
const ACCOUNT = '0'.repeat(32);

function row(rows: readonly QuotaRow[], id: QuotaRow['id']): QuotaRow {
  const found = rows.find((r) => r.id === id);
  if (found === undefined) throw new Error(`missing ${id}`);
  return found;
}

const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();

describe('the usage query', () => {
  it('is the verified query of design.md §7.2, verbatim', () => {
    const block = /### 7\.2[\s\S]*?```graphql\n([\s\S]*?)```/.exec(design)?.[1];
    expect(block).toBeDefined();
    expect(normalise(USAGE_QUERY)).toBe(normalise(block ?? ''));
  });

  it('asks for the UTC day so far and the UTC month to date', () => {
    expect(usageVariables(ACCOUNT, Date.parse('2026-09-29T12:34:56.789Z'))).toEqual({
      a: ACCOUNT,
      day: '2026-09-29',
      start: '2026-09-29T00:00:00Z',
      end: '2026-09-29T12:34:56Z',
      month: '2026-09-01',
    });
  });

  it('has one allowance per resource, with a Cloudflare docs source', () => {
    for (const id of QUOTA_RESOURCES) {
      expect(ALLOWANCES[id].source).toMatch(/^https:\/\/developers\.cloudflare\.com\//);
      expect(ALLOWANCES[id].guardTrigger).toBe(ALLOWANCES[id].period !== 'storage');
    }
  });
});

describe('parseUsage', () => {
  it('maps every dataset with its unit (design.md §7.3)', () => {
    const data = parseUsage(
      graphqlBody({
        workersRequests: 81_000,
        d1RowsRead: 4_100_000,
        d1RowsWritten: 5_000,
        d1Sizes: [300_000_000, 100_000_000],
        doRequests: 900,
        doActiveTimeUs: 3_600_000_000,
        doRowsRead: 10,
        doRowsWritten: 20,
        r2Ops: [
          { actionType: 'PutObject', bucketName: 'b1', requests: 100 },
          { actionType: 'ListObjects', bucketName: 'b2', requests: 50 },
          { actionType: 'GetObject', bucketName: 'b1', requests: 400 },
          { actionType: 'HeadObject', bucketName: 'b2', requests: 100 },
          { actionType: 'DeleteObject', bucketName: 'b1', requests: 999 },
          { actionType: 'SomeFutureOperation', bucketName: 'b2', requests: 7 },
        ],
        r2Storage: [
          { bucketName: 'b1', payloadSize: 2_000_000_000, metadataSize: 5_000_000 },
          { bucketName: 'b2', payloadSize: 1_000_000_000, metadataSize: 0 },
        ],
      }),
      NOW,
    );
    expect(data).not.toBeNull();
    const rows = data?.rows ?? [];
    expect(rows.map((r) => r.id)).toEqual(QUOTA_RESOURCES);
    expect(row(rows, 'workers_requests')).toMatchObject({ used: 81_000, limit: 100_000, percent: 81, period: 'daily', guard_trigger: true });
    expect(row(rows, 'workers_requests').breakdown).toEqual([
      { name: 'mail-hero', value: 60_750 },
      { name: 'todofy', value: 20_250 },
    ]);
    expect(row(rows, 'd1_rows_read')).toMatchObject({ used: 4_100_000, percent: 82 });
    expect(row(rows, 'd1_storage')).toMatchObject({ used: 400_000_000, percent: 8, guard_trigger: false, projected: null });
    expect(row(rows, 'd1_database_max')).toMatchObject({ used: 300_000_000, percent: 60 });
    // 3600 s active x 0.128 GB = 460.8 GB-s.
    expect(row(rows, 'do_duration')).toMatchObject({ used: 460.8, unit: 'gb_seconds' });
    expect(row(rows, 'do_storage')).toMatchObject({ used: null, percent: null, projected: null });
    // Class A: PutObject + ListObjects + the unclassified operation (cautious); DeleteObject is free.
    expect(row(rows, 'r2_class_a')).toMatchObject({ used: 157, period: 'monthly' });
    expect(row(rows, 'r2_class_b')).toMatchObject({ used: 500 });
    expect(data?.unclassified_r2_operations).toBe(7);
    expect(row(rows, 'r2_storage')).toMatchObject({ used: 3_005_000_000 });
    expect(rows.every((r) => !r.truncated)).toBe(true);
  });

  it('counts the bulk DeleteObjects as Class A without calling it unclassified (seen live 2026-09-30)', () => {
    // Every actionType the live account returned in the verified sample: none is unclassified.
    const data = parseUsage(
      graphqlBody({
        r2Ops: [
          { actionType: 'PutObject', bucketName: 'b1', requests: 10 },
          { actionType: 'CompleteMultipartUpload', bucketName: 'b1', requests: 2 },
          { actionType: 'DeleteObjects', bucketName: 'b1', requests: 3 },
          { actionType: 'GetBucketLifecycleConfiguration', bucketName: 'b2', requests: 4 },
          { actionType: 'PutBucket', bucketName: 'b2', requests: 1 },
        ],
      }),
      NOW,
    );
    expect(row(data?.rows ?? [], 'r2_class_a')).toMatchObject({ used: 16 });
    expect(row(data?.rows ?? [], 'r2_class_b')).toMatchObject({ used: 4 });
    expect(data?.unclassified_r2_operations).toBe(0);
  });

  it('documents every R2 operation it classifies (limits.md)', () => {
    for (const action of [...R2_CLASS_A, ...R2_CLASS_B, ...R2_FREE, ...R2_ASSUMED_CLASS_A]) {
      expect(limitsDoc).toContain(`\`${action}\``);
    }
  });

  it('projects daily use over the UTC day and monthly use over the month', () => {
    const rows = parseUsage(graphqlBody({ workersRequests: 30_000 }), NOW)?.rows ?? [];
    // Half the day gone: twice the use.
    expect(row(rows, 'workers_requests')).toMatchObject({ projected: 60_000, projected_percent: 60 });
    // Not in the first 3 hours: a burst just after midnight would read as ~20x the day.
    expect(projection('daily', 100, Date.parse('2026-09-29T01:05:00Z'))).toBeNull();
    expect(projection('daily', 100, Date.parse('2026-09-29T02:59:00Z'))).toBeNull();
    expect(projection('daily', 100, Date.parse('2026-09-29T03:00:00Z'))).toBe(800);
    expect(projection('monthly', 100, Date.parse('2026-09-01T23:00:00Z'))).toBeNull();
    expect(projection('monthly', 100, Date.parse('2026-09-16T00:00:00Z'))).toBe(200);
    expect(projection('storage', 100, NOW)).toBeNull();
    expect(projection('daily', null, NOW)).toBeNull();
  });

  it('marks a dataset that returned as many rows as its limit as truncated', () => {
    const r2Ops = Array.from({ length: 50 }, (_, i) => ({ actionType: 'GetObject', bucketName: `b${String(i)}`, requests: 1 }));
    const rows = parseUsage(graphqlBody({ r2Ops }), NOW)?.rows ?? [];
    expect(row(rows, 'r2_class_b')).toMatchObject({ used: 50, truncated: true });
    expect(row(rows, 'r2_class_b').breakdown).toHaveLength(5);
  });

  it('reads empty storage datasets as no data, never 0', () => {
    const rows = parseUsage(graphqlBody({ d1Sizes: [], r2Storage: [] }), NOW)?.rows ?? [];
    expect(row(rows, 'd1_storage').used).toBeNull();
    expect(row(rows, 'd1_database_max').used).toBeNull();
    expect(row(rows, 'r2_storage').used).toBeNull();
  });

  it('refuses a body without the account or a dataset', () => {
    expect(parseUsage({ data: { viewer: { accounts: [] } } }, NOW)).toBeNull();
    expect(parseUsage(null, NOW)).toBeNull();
    const body = graphqlBody() as { data: { viewer: { accounts: Record<string, unknown>[] } } };
    delete body.data.viewer.accounts[0]?.r2ops;
    expect(parseUsage(body, NOW)).toBeNull();
  });
});

describe('parseUsage per script and per resource (design-v2.md §4)', () => {
  it('keeps each script\'s requests, errors, subrequests, CPU quantiles and DO invocations', () => {
    const data = parseUsage(graphqlBody(REALISTIC_USAGE), NOW);
    expect(data?.workers_truncated).toBe(false);
    expect(data?.scripts).toEqual([
      { script: 'mail-hero', requests: 268, errors: 0, subrequests: 41, cpu_p50_us: 1123, cpu_p99_us: 4811, do_requests: 612, do_errors: 0 },
      { script: 'todofy', requests: 214, errors: 2, subrequests: 58, cpu_p50_us: 902, cpu_p99_us: 3599, do_requests: null, do_errors: null },
      { script: 'home', requests: 118, errors: 0, subrequests: 29, cpu_p50_us: 811, cpu_p99_us: 2904, do_requests: 136, do_errors: 0 },
      { script: 'todofy-core', requests: 96, errors: 0, subrequests: 37, cpu_p50_us: 1403, cpu_p99_us: 6207, do_requests: 632, do_errors: 0 },
      { script: 'ziyixi-notion-publish', requests: 16, errors: 1, subrequests: 48, cpu_p50_us: 2312, cpu_p99_us: 7402, do_requests: null, do_errors: null },
    ]);
    // The quota rows are unchanged by the per-script parse.
    expect(row(data?.rows ?? [], 'workers_requests')).toMatchObject({ used: 712 });
    expect(row(data?.rows ?? [], 'do_requests')).toMatchObject({ used: 1380 });
  });

  it('keeps a script seen only in doInv, sums a repeated name and reads a missing quantile as null', () => {
    const body = graphqlBody({
      scripts: [
        { script: 'a', requests: 5, errors: 1, subrequests: 2, cpuP50: 100, cpuP99: 900 },
        { script: 'a', requests: 7, errors: 0, subrequests: 1, cpuP50: 300, cpuP99: 200 },
      ],
      doScripts: [{ script: 'do-only', requests: 30, errors: 2 }],
    }) as { data: { viewer: { accounts: { workers: { quantiles?: unknown }[] }[] } } };
    delete body.data.viewer.accounts[0]?.workers[1]?.quantiles;
    const data = parseUsage(body, NOW);
    expect(data?.scripts).toEqual([
      { script: 'a', requests: 12, errors: 1, subrequests: 3, cpu_p50_us: 100, cpu_p99_us: 900, do_requests: null, do_errors: null },
      { script: 'do-only', requests: 0, errors: 0, subrequests: 0, cpu_p50_us: null, cpu_p99_us: null, do_requests: 30, do_errors: 2 },
    ]);
  });

  it.each([0, 5, 20, 50])('parses %i scripts, and a full page of 50 as truncated', (count) => {
    const data = parseUsage(graphqlBody(usageWithScripts(count)), NOW);
    expect(data?.scripts.filter((s) => s.requests > 0)).toHaveLength(count);
    expect(data?.workers_truncated).toBe(count >= 50);
    expect(row(data?.rows ?? [], 'workers_requests').truncated).toBe(count >= 50);
    expect(new Set(data?.scripts.map((s) => s.script)).size).toBe(data?.scripts.length);
  });

  it('lists D1, DO and R2 resources by their GraphQL identifier, R2 by class', () => {
    const resources = parseUsage(graphqlBody(REALISTIC_USAGE), NOW)?.resources;
    expect(resources?.d1).toEqual([
      { id: SYNTHETIC_D1[0], size_bytes: 38_900_000, rows_read: 5210, rows_written: 318 },
      { id: SYNTHETIC_D1[1], size_bytes: 7_300_000, rows_read: 1932, rows_written: 168 },
    ]);
    expect(resources?.do.map((ns) => ns.id)).toEqual([...SYNTHETIC_NS]);
    expect(resources?.do[0]).toEqual({ id: SYNTHETIC_NS[0], rows_read: 12_100, rows_written: 1040 });
    // DeleteObject is free: it adds nothing to either class.
    expect(resources?.r2).toEqual([
      { id: 'mail-hero-store', size_bytes: 781_000_000, class_a: 15_900, class_b: 52_800 },
      { id: 'backup-synthetic', size_bytes: 56_000_000, class_a: 1_210, class_b: 3_100 },
    ]);
  });

  it('puts R2 operations without a bucket under unclassified, and a bucket without storage as null size', () => {
    const body = graphqlBody({
      r2Ops: [{ actionType: 'ListBuckets', bucketName: '', requests: 4 }, { actionType: 'HeadObject', bucketName: 'b9', requests: 2 }],
      r2Storage: [],
    });
    expect(parseUsage(body, NOW)?.resources.r2).toEqual([
      { id: 'b9', size_bytes: null, class_a: 0, class_b: 2 },
      { id: 'unclassified', size_bytes: null, class_a: 4, class_b: 0 },
    ]);
  });
});

describe('fetchUsage', () => {
  function fetcher(response: () => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return response();
    };
    return { fn, calls };
  }

  it('sends the token only as the bearer of one POST to the GraphQL URL', async () => {
    const { fn, calls } = fetcher(() => Response.json(graphqlBody()));
    const log = vi.spyOn(console, 'log');
    const result = await fetchUsage(TOKEN, ACCOUNT, NOW, fn);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(GRAPHQL_URL);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('manual');
    const headers = new Headers(call?.init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(call?.init.body as string) as { query: string; variables: Record<string, string> };
    expect(body.query).toBe(USAGE_QUERY);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(log).not.toHaveBeenCalled();
  });

  it('makes no request without a token', async () => {
    const { fn, calls } = fetcher(() => Response.json(graphqlBody()));
    expect(await fetchUsage(undefined, ACCOUNT, NOW, fn)).toEqual({ ok: false, code: 'not_configured', http_status: null });
    expect(await fetchUsage('  ', ACCOUNT, NOW, fn)).toEqual({ ok: false, code: 'not_configured', http_status: null });
    expect(calls).toHaveLength(0);
  });

  it('turns every failure into a code without remote text', async () => {
    const cases: [() => Response | Promise<Response>, string, number | null][] = [
      [() => new Response('token secret-text', { status: 401 }), 'http_401', 401],
      [() => new Response('oops', { status: 500 }), 'http_500', 500],
      [() => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }), 'http_302', 302],
      [() => Response.json({ data: null, errors: [{ message: 'not authorized for account secret-text' }] }), 'graphql_error', 200],
      [() => new Response('not json', { status: 200 }), 'invalid_response', 200],
      [() => Response.json({ data: { viewer: { accounts: [] } } }), 'invalid_response', 200],
      [() => new Response('x'.repeat(1_000_001), { status: 200 }), 'invalid_response', 200],
      [() => Promise.reject(new TypeError('network down secret-text')), 'network_error', null],
      [() => Promise.reject(new DOMException('timed out', 'TimeoutError')), 'timeout', null],
    ];
    for (const [response, code, status] of cases) {
      const result = await fetchUsage(TOKEN, ACCOUNT, NOW, fetcher(response).fn);
      expect(result).toEqual({ ok: false, code, http_status: status });
      expect(JSON.stringify(result)).not.toContain('secret-text');
    }
  });
});
