import { describe, expect, it, vi } from 'vitest';
import design from '../../docs/design.md?raw';
import { QUOTA_RESOURCES, type QuotaRow } from '../src/api-types.ts';
import { ALLOWANCES } from '../src/limits.ts';
import { GRAPHQL_URL, USAGE_QUERY, fetchUsage, parseUsage, projection, usageVariables, type FetchLike } from '../src/usage.ts';
import { graphqlBody } from './graphql-fixture.ts';

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

  it('projects daily use over the UTC day and monthly use over the month', () => {
    const rows = parseUsage(graphqlBody({ workersRequests: 30_000 }), NOW)?.rows ?? [];
    // Half the day gone: twice the use.
    expect(row(rows, 'workers_requests')).toMatchObject({ projected: 60_000, projected_percent: 60 });
    expect(projection('daily', 100, Date.parse('2026-09-29T00:59:00Z'))).toBeNull();
    expect(projection('daily', 100, Date.parse('2026-09-29T01:00:00Z'))).toBe(2400);
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
