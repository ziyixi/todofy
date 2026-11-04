import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import { ObjectScanSchema, type ObjectScan, type Overview } from '@ziyixi/proto/storage/ui/v1/overview_pb';
import { toWire } from '@ziyixi/proto/wire-json';
import { describe, expect, it, vi } from 'vitest';
import type { Dropbox } from '../src/dropbox.ts';
import { handlers, type OwnerContext } from '../src/owner.ts';
import { addPage, runScan, SCAN_MAX_PAGES, SCAN_PAGES_PER_RUN, SCAN_STALE_MS, startScan, storedScan, type Scan } from '../src/scan.ts';
import type { Store } from '../src/store.ts';
import { sqliteStore } from './sqlite.ts';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const RECENT = '2026-11-01T08:00:00Z';
const OLD = '2026-10-01T08:00:00Z';
const file = (path: string, size: number, modified = OLD) => ({ '.tag': 'file', path_lower: path, path_display: path.toUpperCase(), size, server_modified: modified });

function scan(): Scan {
  return { id: 'synthetic', state: 'running', start: NOW, update: NOW, end: 0, cursor: '', pages: 0, runs: 0, retries: 0, reason: '', objects: 0, bytes: 0, namespaces: [] };
}

/** A Dropbox stand-in that answers queued listing pages or refusals and records every call. */
function provider(answers: (Record<string, unknown> | RpcError)[]) {
  const calls: { readonly method: string; readonly args: unknown }[] = [];
  const dropbox = {
    scanPage: (method: string, args: unknown) => {
      calls.push({ method, args });
      const answer = answers.shift() ?? { entries: [], has_more: true, cursor: 'synthetic-more' };
      return answer instanceof RpcError ? Promise.reject(answer) : Promise.resolve(answer);
    },
  } as unknown as Pick<Dropbox, 'scanPage'>;
  return { dropbox, calls };
}

const page = (entries: unknown[], more: boolean, cursor = 'synthetic-' + String(entries.length)) => ({ entries, has_more: more, cursor });
const reasonOf = (run: () => void): string => {
  try { run(); } catch (error) { return error instanceof RpcError ? error.reason : 'OTHER'; }
  return 'NONE';
};
const rateLimited = (seconds: string) => new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', 'Synthetic.', { httpStatus: 429, headers: { 'retry-after': seconds } });

describe('object scan totals', () => {
  it('adds files by namespace and top-level folder, recent ones by when Dropbox wrote them', () => {
    const value = scan();
    addPage(value, [
      { '.tag': 'folder', path_lower: '/namespaces/alpha/blocks' },
      file('/namespaces/alpha/blocks/sealed/0001', 1000, RECENT),
      file('/namespaces/alpha/blocks/sealed/0002', 3000, RECENT),
      file('/namespaces/alpha/blocks/head.bin', 10),
      file('/namespaces/alpha/tables/part-1', 200),
      file('/namespaces/alpha/root.json', 5, RECENT),
      file('/namespaces/beta/x/y', 7),
      // Not in a namespace folder: only the scan's totals.
      file('/namespaces/stray.bin', 1),
      file('/namespaces/Bad Name/file', 2),
      { '.tag': 'deleted', path_lower: '/namespaces/alpha/gone' },
    ]);
    expect([value.objects, value.bytes]).toEqual([8, 4225]);
    expect(value.namespaces).toEqual([
      {
        name: 'alpha', objects: 5, bytes: 4215, recentObjects: 3, recentBytes: 4005, folders: [
          { name: 'blocks', objects: 3, bytes: 4010, recentObjects: 2, recentBytes: 4000 },
          { name: 'tables', objects: 1, bytes: 200, recentObjects: 0, recentBytes: 0 },
          { name: '', objects: 1, bytes: 5, recentObjects: 1, recentBytes: 5 },
        ],
      },
      { name: 'beta', objects: 1, bytes: 7, recentObjects: 0, recentBytes: 0, folders: [{ name: 'x', objects: 1, bytes: 7, recentObjects: 0, recentBytes: 0 }] },
    ]);
  });

  it('checks a whole page before adding any of it', () => {
    const value = scan();
    for (const bad of [{ '.tag': 'file', path_lower: '/namespaces/alpha/a', size: -1 }, { '.tag': 'file', size: 3 }, 'synthetic', null]) {
      expect(reasonOf(() => { addPage(value, [file('/namespaces/alpha/ok', 3), bad]); })).toBe('PROVIDER_RESPONSE_INVALID');
    }
    expect(reasonOf(() => { addPage(value, { entries: [] }); })).toBe('PROVIDER_RESPONSE_INVALID');
    expect([value.objects, value.namespaces]).toEqual([0, []]);
  });

  it('tracks at most 64 namespaces and 32 folders each; the rest count in the totals above them', () => {
    const value = scan();
    addPage(value, Array.from({ length: 70 }, (_, index) => file('/namespaces/n' + String(index).padStart(2, '0') + '/f/a', 1)));
    addPage(value, Array.from({ length: 40 }, (_, index) => file('/namespaces/n00/f' + String(index) + '/a', 2)));
    expect(value.objects).toBe(110);
    expect(value.namespaces).toHaveLength(64);
    const first = value.namespaces[0];
    expect(first?.folders).toHaveLength(32);
    expect([first?.objects, first?.bytes]).toEqual([41, 81]);
  });
});

describe('object scan runs', () => {
  it('lists the namespaces folder, follows continuations, writes every page and succeeds on the last', async () => {
    const { store } = sqliteStore();
    const { scan: value, started } = startScan(store, NOW);
    expect(started).toBe(true);
    const writes = vi.spyOn(store, 'set');
    const { dropbox, calls } = provider([
      page([file('/namespaces/alpha/a/1', 10)], true, 'synthetic-c1'),
      page([file('/namespaces/alpha/a/2', 20)], true, 'synthetic-c2'),
      page([file('/namespaces/beta/b/3', 30)], false),
    ]);
    expect(await runScan(store, dropbox, () => NOW + 5)).toBeNull();
    expect(calls).toEqual([
      { method: 'files/list_folder', args: { path: '/namespaces', recursive: true, include_deleted: false, include_non_downloadable_files: false, limit: 1000 } },
      { method: 'files/list_folder/continue', args: { cursor: 'synthetic-c1' } },
      { method: 'files/list_folder/continue', args: { cursor: 'synthetic-c2' } },
    ]);
    expect(writes).toHaveBeenCalledTimes(3);
    expect(storedScan(store)).toMatchObject({ id: value.id, state: 'succeeded', end: NOW + 5, pages: 3, runs: 1, objects: 3, bytes: 60 });
    expect(await runScan(store, dropbox)).toBeNull();
    expect(calls).toHaveLength(3);
  });

  it('stops a run after 40 pages and continues it in the next one a second later', async () => {
    const { store } = sqliteStore();
    startScan(store, NOW);
    const { dropbox, calls } = provider([]);
    expect(await runScan(store, dropbox, () => NOW)).toBe(NOW + 1000);
    expect(calls).toHaveLength(SCAN_PAGES_PER_RUN);
    expect(storedScan(store)).toMatchObject({ state: 'running', pages: 40, runs: 1, cursor: 'synthetic-more' });
    await runScan(store, dropbox, () => NOW);
    expect(calls.at(-1)).toEqual({ method: 'files/list_folder/continue', args: { cursor: 'synthetic-more' } });
    expect(storedScan(store)).toMatchObject({ pages: 80, runs: 2 });
  });

  it('stops a run after a minute and a scan after 1,000 pages', async () => {
    const { store } = sqliteStore();
    startScan(store, NOW);
    let clock = NOW;
    const { dropbox, calls } = provider([]);
    expect(await runScan(store, dropbox, () => (clock += 20_000))).not.toBeNull();
    expect(calls.length).toBeLessThan(4);
    const value = storedScan(store);
    if (value === null) throw new Error('no synthetic scan');
    store.set('object_scan', { ...value, pages: SCAN_MAX_PAGES });
    expect(await runScan(store, dropbox, () => NOW)).toBeNull();
    expect(storedScan(store)).toMatchObject({ state: 'failed', reason: 'SCAN_PAGE_LIMIT' });
  });

  it('retries a rate limit or outage three times in a row after its delay, then fails with the reason', async () => {
    const { store } = sqliteStore();
    startScan(store, NOW);
    const outage = new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', 'Synthetic.', { httpStatus: 503 });
    const { dropbox } = provider([rateLimited('7'), page([file('/namespaces/alpha/a', 1)], true, 'synthetic-c1'), rateLimited('9999'), outage, outage, outage]);
    expect(await runScan(store, dropbox, () => NOW)).toBe(NOW + 7000);
    expect(storedScan(store)).toMatchObject({ state: 'running', retries: 1, pages: 0 });
    // A page resets the count; Retry-After is bounded at five minutes and an outage waits 30 seconds.
    expect(await runScan(store, dropbox, () => NOW)).toBe(NOW + 300_000);
    expect(storedScan(store)).toMatchObject({ retries: 1, pages: 1, cursor: 'synthetic-c1' });
    expect(await runScan(store, dropbox, () => NOW)).toBe(NOW + 30_000);
    expect(await runScan(store, dropbox, () => NOW)).toBe(NOW + 30_000);
    expect(await runScan(store, dropbox, () => NOW + 1)).toBeNull();
    expect(storedScan(store)).toMatchObject({ state: 'failed', reason: 'UNAVAILABLE', end: NOW + 1, objects: 1 });
  });

  it('retries a page that broke off or was malformed, and fails at once on a reset cursor', async () => {
    const { store } = sqliteStore();
    startScan(store, NOW);
    const { dropbox } = provider([
      new RpcError(Code.UNAVAILABLE, 'PROVIDER_RESPONSE_INVALID', 'Synthetic.'), page([], true, ''),
      page([file('/namespaces/alpha/a', 1)], true, 'synthetic-c1'), new RpcError(Code.INVALID_ARGUMENT, 'CURSOR_INVALID', 'Synthetic.'),
    ]);
    expect(await runScan(store, dropbox, () => NOW)).toBe(NOW + 30_000);
    expect(await runScan(store, dropbox, () => NOW)).toBe(NOW + 30_000);
    expect(storedScan(store)).toMatchObject({ state: 'running', retries: 2, pages: 0 });
    expect(await runScan(store, dropbox, () => NOW)).toBeNull();
    expect(storedScan(store)).toMatchObject({ state: 'failed', reason: 'CURSOR_INVALID', pages: 1, objects: 1, runs: 3 });
  });

  it('fails at once on a definite refusal, and succeeds empty when no namespace has a folder', async () => {
    const { store } = sqliteStore();
    startScan(store, NOW);
    await runScan(store, provider([new RpcError(Code.FAILED_PRECONDITION, 'CONNECTION_INVALID', 'Synthetic.')]).dropbox, () => NOW);
    expect(storedScan(store)).toMatchObject({ state: 'failed', reason: 'CONNECTION_INVALID', runs: 1 });
    startScan(store, NOW);
    await runScan(store, provider([new RpcError(Code.NOT_FOUND, 'NOT_FOUND', 'Synthetic.')]).dropbox, () => NOW);
    expect(storedScan(store)).toMatchObject({ state: 'succeeded', objects: 0, namespaces: [] });
  });

  it('keeps a running scan, restarts one that stopped moving, and drops a run a newer scan replaced', async () => {
    const { store } = sqliteStore();
    const first = startScan(store, NOW).scan;
    expect(startScan(store, NOW + SCAN_STALE_MS - 1)).toMatchObject({ started: false, scan: { id: first.id } });
    const second = startScan(store, NOW + SCAN_STALE_MS).scan;
    expect(second.id).not.toBe(first.id);
    let replace = (): void => undefined;
    const dropbox = {
      scanPage: () => { replace(); return Promise.resolve(page([file('/namespaces/alpha/a', 1)], true)); },
    } as unknown as Pick<Dropbox, 'scanPage'>;
    replace = () => { store.set('object_scan', { ...second, id: 'synthetic-newer' }); };
    expect(await runScan(store, dropbox, () => NOW)).toBeNull();
    expect(storedScan(store)).toMatchObject({ id: 'synthetic-newer', pages: 0, objects: 0 });
  });
});

describe('owner scan API', () => {
  function context(store: Store, scheduleScan = vi.fn(() => Promise.resolve())): OwnerContext {
    return {
      store, dropbox: {} as Dropbox, redirectUri: 'https://storage.example.test/api/dropbox/callback', flushUsage: vi.fn(), buildSha: 'synthetic',
      stateSizeBytes: () => 0, scheduleScan,
    };
  }

  it('starts a scan once while connected and schedules its first run', async () => {
    const { store } = sqliteStore();
    const scheduleScan = vi.fn(() => Promise.resolve());
    await expect(handlers.startObjectScan({ name: 'objectScan' } as never, context(store, scheduleScan))).rejects.toMatchObject({ reason: 'NOT_CONFIGURED' });
    await expect(handlers.startObjectScan({ name: 'scan' } as never, context(store, scheduleScan))).rejects.toMatchObject({ reason: 'BAD_REQUEST' });
    store.set('connection', { appKey: 'syntheticappkey', refreshToken: 'synthetic-private-refresh', generation: 'synthetic' });
    const started = toWire(ObjectScanSchema, await handlers.startObjectScan({ name: 'objectScan' } as never, context(store, scheduleScan)) as ObjectScan) as Record<string, unknown>;
    expect(started).toMatchObject({ name: 'objectScan', state: 'running' });
    await handlers.startObjectScan({ name: 'objectScan' } as never, context(store, scheduleScan));
    expect(scheduleScan).toHaveBeenCalledOnce();
    expect(scheduleScan).toHaveBeenCalledWith(Date.parse(started.start_time as string));
  });

  it('answers namespaces in name order with their eight largest folders', async () => {
    const { store } = sqliteStore();
    store.set('connection', { appKey: 'syntheticappkey', refreshToken: 'synthetic-private-refresh', generation: 'synthetic' });
    const value = scan();
    addPage(value, [
      ...Array.from({ length: 10 }, (_, index) => file('/namespaces/zeta/f' + String(index) + '/a', (index + 1) * 100, index === 9 ? RECENT : OLD)),
      file('/namespaces/alpha/a.bin', 4),
    ]);
    Object.assign(value, { state: 'succeeded', end: NOW + 60_000, pages: 1, runs: 1 });
    store.set('object_scan', value);
    const overview = await handlers.getOverview({ name: 'overview' } as never, {
      ...context(store), dropbox: { space: () => Promise.resolve({ state: 'scope_missing', used: 0, allocated: 0, time: NOW }) } as unknown as Dropbox,
    }) as Overview;
    const wire = toWire(ObjectScanSchema, overview.objectScan as ObjectScan) as { namespaces: { namespace: string; folders: { folder: string; total_bytes: number }[] }[] };
    expect(wire).toMatchObject({ state: 'succeeded', start_time: '2026-11-03T12:00:00Z', end_time: '2026-11-03T12:01:00Z', page_count: 1, run_count: 1, object_count: 11, total_bytes: 5504 });
    expect(wire.namespaces.map((item) => item.namespace)).toEqual(['alpha', 'zeta']);
    // The namespace's root is the folder '', which the wire leaves out.
    expect(wire.namespaces[0]?.folders).toEqual([{ object_count: 1, total_bytes: 4 }]);
    expect(wire.namespaces[1]?.folders.map((folder) => folder.folder)).toEqual(['f9', 'f8', 'f7', 'f6', 'f5', 'f4', 'f3', 'f2']);
    expect(wire.namespaces[1]).toMatchObject({ object_count: 10, total_bytes: 5500, recent_object_count: 1, recent_bytes: 1000 });
    expect(overview.space?.state).toBe(2);
  });
});
