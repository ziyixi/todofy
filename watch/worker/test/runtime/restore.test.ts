/**
 * docs/backup.md rehearsed with the real WatchState in workerd: a store with watches, changes, notifications, a task
 * request Tasks never created and page evidence (texts and a screenshot) backs itself up from its alarm at the daily
 * slot (owner writes refused meanwhile, Home's view after); tools/backup-restore.ts downloads the backup with wrangler,
 * checks it and uploads it into the bucket of a new namespace; the owner restores it there through the API (the private
 * binding may not, other writes wait); the new store then equals the old one row for row, its empty evidence bucket
 * holds every object byte for byte, and nothing old acts again: no task, no Work report (the event feed's positions
 * expire). An object the Worker no longer addresses stops its alarm. Synthetic pages only.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpClient } from '@ziyixi/proto/http-client';
import { BackupRestore_State, WatchUiService } from '@ziyixi/proto/watch/ui/v1/watch_ui_service_pb';
import { Watch_Fetcher, Watch_NotifyPolicy } from '@ziyixi/proto/watch/ui/v1/watch_pb';
import type { Manifest } from '../../src/backup.ts';
import { RESTORE_SEQUENCE_GAP } from '../../src/restore.ts';
import { page } from '../fake-sites.ts';
import { DAY, HOUR, MINUTE, op, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, '../../../tools/backup-restore.ts');
/** 2026-10-02T11:23:00Z: the daily slot after a day of checks. */
const SLOT = T0 + DAY + 11 * HOUR + 23 * MINUTE;
const SHOP = 'https://shop.example.com/kettle';
const ALERT = 'https://tickets.example.com/concert';
const SPA = 'https://spa.example.com/app';

let a: Harness;
let b: Harness | undefined;
let work: string;

beforeAll(async () => {
  a = await startHarness({ evidence: true, backups: true, browser: true, tasks: true });
  work = await mkdtemp(join(tmpdir(), 'watch-restore-'));
});

afterAll(async () => {
  await a.dispose();
  await b?.dispose();
  await rm(work, { recursive: true, force: true });
});

function privateClient(harness: Harness) {
  return createHttpClient(WatchUiService, (call) =>
    harness.serviceFetch(call.url, { method: call.httpMethod, ...(call.body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: call.body }) }),
  );
}

const shop = (n: number) => page('Synthetic kettle', `<p>The synthetic kettle costs ${String(100 - n)} coins today.</p><p>Stable footer line.</p>`);
const alert = (n: number) => page('Synthetic tickets', `<p>Synthetic concert seats left: ${String(40 - n)} in the hall.</p>`);
const spa = page('Synthetic app', '<p>Rendered by JavaScript: 42 synthetic items in stock.</p>');

/** Every table of the store but the backup's own record, as SQL literals per row (BLOBs and types exactly). */
async function dump(h: Harness): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  const names = await h.sql<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__cf_*' ORDER BY name`);
  for (const { name } of names) {
    if (name === 'backup_evidence' || name === 'previews') continue;
    const columns = (await h.sql<{ name: string }>(`PRAGMA table_info("${name}")`)).map((row) => row.name);
    const rows = await h.sql(`SELECT ${columns.map((column) => `quote("${column}") AS "${column}"`).join(', ')} FROM "${name}"`);
    out[name] = rows.map((row) => JSON.stringify(row)).filter((row) => !/"key":"'(backup|restore|schema_version)'"/.test(row)).sort();
  }
  return out;
}

async function backupJobOpen(h: Harness): Promise<boolean> {
  const [row] = await h.sql<{ value: string }>(`SELECT value FROM meta WHERE key = 'backup'`);
  return row !== undefined && (JSON.parse(row.value) as { job: unknown }).job !== null;
}

const tool = (...args: string[]) => spawnSync('node', [TOOL, ...args], { encoding: 'utf8' });

describe('backup and restore of the real WatchState', () => {
  it('backs up at the daily slot, restores into a new namespace, and nothing old acts again', async () => {
    // A day of a store: three watches (one rendered with a screenshot), changes, a digest, an urgent task, one more of
    // each waiting, and a task request Tasks never created.
    a.sites.html(SHOP, shop(0));
    a.sites.html(ALERT, alert(0));
    a.browser.pages.set(SPA, spa);
    await a.clock(T0 + HOUR);
    await a.api.createWatch({ watchId: 'shop', requestId: op(), watch: { displayName: '合成：水壶', uri: SHOP, checkIntervalMinutes: 60, stability: { skipConfirmation: true } } });
    await a.api.createWatch({ watchId: 'alert', requestId: op(), watch: { displayName: '合成：门票', uri: ALERT, checkIntervalMinutes: 60, notifyPolicy: Watch_NotifyPolicy.URGENT, stability: { skipConfirmation: true } } });
    await a.api.createWatch({ watchId: 'spa', requestId: op(), watch: { displayName: '合成：应用', uri: SPA, fetcher: Watch_Fetcher.BROWSER } });
    // The first alarm after the release backs the store up at once (it has no backup state), then checks.
    await a.run(T0 + HOUR);
    expect((await a.api.getServiceStatus({ name: 'serviceStatus' })).lastBackup).toBe('backups/2026-10-01T010000Z/');
    a.sites.html(SHOP, shop(1));
    a.sites.html(ALERT, alert(1));
    await a.clock(T0 + 3 * HOUR);
    await a.run(T0 + 3 * HOUR);
    await a.clock(T0 + 14 * HOUR);
    await a.run(T0 + 14 * HOUR);
    const sent = (await a.tasksState()).tasks.length;
    expect(sent).toBe(2);
    a.sites.html(SHOP, shop(2));
    a.sites.html(ALERT, alert(2));
    await a.tasks({ create: 'throw' });
    await a.clock(T0 + 16 * HOUR);
    await a.run(T0 + 16 * HOUR);
    const [open] = await a.sql<{ intent_id: string }>(`SELECT intent_id FROM intents WHERE state = 'open'`);
    expect(open).toBeDefined();
    expect(await a.sql(`SELECT count(*) AS n FROM notifications WHERE delivered_at IS NULL`)).toEqual([{ n: 1 }]);
    const cursor = (await privateClient(a).pollWatchEvents({ baseline: true, cursor: '', pageSize: 100 })).cursor;
    expect(await a.sql(`SELECT count(*) AS n FROM evidence_snapshots WHERE image_key != ''`)).not.toEqual([{ n: 0 }]);

    // The daily slot: the job copies the store in steps; meanwhile owner writes wait, reads go on.
    await a.clock(SLOT);
    expect((await a.step(SLOT)) as unknown).toMatchObject({ job: 'backup' });
    expect(reasonOf(await rejection(a.api.createWatch({ watchId: 'late', requestId: op(), watch: { displayName: 'late', uri: SHOP } })))).toBe('BACKUP_RUNNING');
    expect(reasonOf(await rejection(a.api.pauseWatch({ name: 'watches/shop', requestId: op() })))).toBe('BACKUP_RUNNING');
    expect((await a.api.getWatch({ name: 'watches/shop' })).displayName).toBe('合成：水壶');
    let at = SLOT;
    for (let steps = 0; (await backupJobOpen(a)) && steps < 50; steps++) at = (await a.step(at + 1000)).next;
    expect(await backupJobOpen(a)).toBe(false);
    const status = await a.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.lastBackup).toBe('backups/2026-10-02T112300Z/');
    expect(status.backupFailed).toBe(false);
    const ops = (await a.opsStatus()) as { counters: Record<string, number>; last_backup_at: string | null; signals: { code: string }[] };
    expect(ops.last_backup_at).toMatch(/^2026-10-02T11:23:0\dZ$/);
    expect(ops.counters.backup_age_seconds).toBeGreaterThanOrEqual(0);
    expect(ops.signals.map((signal) => signal.code)).not.toContain('backup_failed');
    const source = await dump(a);

    // The owner's machine: download the newest backup, check it, upload it into a new namespace's bucket.
    const downloaded = tool('download', '--out', join(work, 'restore'), '--local', '--persist-to', a.persistTo);
    expect(downloaded.status, downloaded.stderr).toBe(0);
    expect(downloaded.stdout).toContain('backup backups/2026-10-02T112300Z/\n');
    expect(downloaded.stdout).toMatch(/\nPASS watches rows=3 parts=1\n/);
    expect(downloaded.stdout.trim().split('\n').at(-1)).toBe('download PASS');
    const verified = tool('verify', '--in', join(work, 'restore'));
    expect(verified.status, verified.stderr).toBe(0);
    const target = join(work, 'new-namespace');
    const uploaded = tool('upload', '--in', join(work, 'restore'), '--bucket', 'watch-backups', '--local', '--persist-to', target);
    expect(uploaded.status, uploaded.stderr).toBe(0);
    const restoreTarget = await startHarness({ evidence: true, backups: true, browser: true, tasks: true, persistTo: target });
    b = restoreTarget;
    b.sites.html(SHOP, shop(2));
    b.sites.html(ALERT, alert(2));
    b.browser.pages.set(SPA, spa);

    // A new object: an empty store is never backed up (the good backups stay), and it may be restored.
    const restoredAt = SLOT + 2 * HOUR;
    await b.clock(restoredAt);
    expect((await b.step(restoredAt)) as unknown).toMatchObject({ outcomes: {} });
    expect(await b.mf.getR2Bucket('BACKUPS').then((bucket) => bucket.get('latest.json'))).toBeNull();
    // An upload writes no latest.json: the restore names the backup.
    expect(reasonOf(await rejection(b.api.restoreBackup({ name: 'serviceStatus', backup: '' })))).toBe('BACKUP_NOT_FOUND');
    const forbidden = await b.serviceFetch('/api/v1/serviceStatus:restoreBackup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, 'read-write');
    expect(forbidden.status).toBe(403);
    const started = await b.api.restoreBackup({ name: 'serviceStatus', backup: 'backups/2026-10-02T112300Z' });
    expect(started.restore?.state).toBe(BackupRestore_State.RUNNING);
    expect(started.restore?.backup).toBe('backups/2026-10-02T112300Z/');
    // Repeating it while it runs answers its progress; another backup or a write is refused.
    expect((await b.api.restoreBackup({ name: 'serviceStatus', backup: '' })).restore?.state).toBe(BackupRestore_State.RUNNING);
    expect(reasonOf(await rejection(b.api.createWatch({ watchId: 'early', requestId: op(), watch: { displayName: 'early', uri: SHOP } })))).toBe('RESTORE_RUNNING');
    // Its steps, and not one more: the next alarm would check the watches.
    at = restoredAt;
    for (let steps = 0; steps < 50; steps++) {
      at = (await b.step(at)).next;
      if ((await b.api.getServiceStatus({ name: 'serviceStatus' })).restore?.state !== BackupRestore_State.RUNNING) break;
    }
    const done = (await b.api.getServiceStatus({ name: 'serviceStatus' })).restore;
    expect(done?.state).toBe(BackupRestore_State.SUCCEEDED);
    const manifest = (await (await b.mf.getR2Bucket('BACKUPS')).get('backups/2026-10-02T112300Z/manifest.json').then((object) => object?.json())) as Manifest;
    expect(done?.tables.map((table) => [table.table, table.restoredRowCount, table.expectedRowCount])).toEqual(manifest.tables.map((table) => [table.name, table.rows, table.rows]));
    expect(manifest.evidence.objects.filter((object) => object.key.startsWith('captures/')).length).toBeGreaterThanOrEqual(5);
    expect(manifest.evidence.objects.filter((object) => object.key.startsWith('images/')).length).toBe(1);
    expect(done?.evidenceRestoredCount).toBe(manifest.evidence.objects.length);
    expect(done?.evidenceMissingCount).toBe(0);

    // Row for row, but for what keeps the old state from acting again.
    const restored = await dump(b);
    expect(Object.keys(restored)).toEqual(Object.keys(source));
    for (const name of Object.keys(source)) if (!['notifications', 'intents', 'sqlite_sequence', 'meta'].includes(name)) expect(restored[name], name).toEqual(source[name]);
    const events = `SELECT id, kind, watch_id, change_id, policy, created_at, evidence_only, before_evidence, after_evidence FROM notifications ORDER BY id`;
    expect(await b.sql(events)).toEqual(await a.sql(events));
    expect(await b.sql(`SELECT count(*) AS n FROM notifications WHERE delivered_at IS NULL`)).toEqual([{ n: 0 }]);
    expect(await b.sql(`SELECT state, last_code FROM intents WHERE intent_id = ?`, open?.intent_id ?? '')).toEqual([{ state: 'superseded', last_code: 'restored' }]);
    const floor = (rows: string[] | undefined) => (rows ?? []).filter((row) => !row.includes(`"key":"'watch_events_floor'"`));
    expect(floor(restored.meta)).toEqual(floor(source.meta));
    const [head] = await a.sql<{ seq: number }>(`SELECT seq FROM sqlite_sequence WHERE name = 'notifications'`);
    expect(await b.sql(`SELECT seq FROM sqlite_sequence WHERE name = 'notifications'`)).toEqual([{ seq: (head?.seq ?? 0) + RESTORE_SEQUENCE_GAP }]);

    // The evidence: an empty bucket now holds every object the snapshots name, byte for byte.
    const oldEvidence = await a.mf.getR2Bucket('EVIDENCE_STORE');
    const newEvidence = await b.mf.getR2Bucket('EVIDENCE_STORE');
    expect((await newEvidence.list()).objects.map((object) => object.key).sort()).toEqual(manifest.evidence.objects.map((object) => object.key).sort());
    const bytes = async (bucket: typeof oldEvidence, key: string) =>
      Array.from(new Uint8Array(await ((await bucket.get(key)) as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer()));
    for (const object of manifest.evidence.objects) expect(await bytes(newEvidence, object.key), object.key).toEqual(await bytes(oldEvidence, object.key));
    const shown = await b.api.getWatch({ name: 'watches/spa' });
    const image = await b.api.getSnapshotImage({ name: `${shown.latestSnapshot}/image` });
    expect(image.available).toBe(true);

    // Nothing old acts again: a day of checks and the digest send no task, and a saved feed position expires.
    expect(reasonOf(await rejection(privateClient(b).pollWatchEvents({ cursor, baseline: false, pageSize: 100 })))).toBe('CURSOR_EXPIRED');
    const fresh = await privateClient(b).pollWatchEvents({ baseline: true, cursor: '', pageSize: 100 });
    expect((await privateClient(b).pollWatchEvents({ cursor: fresh.cursor, baseline: false, pageSize: 100 })).events).toEqual([]);
    for (let day = restoredAt; day <= restoredAt + DAY; day += 2 * HOUR) {
      await b.clock(day);
      await b.run(day);
    }
    expect(await b.tasksState()).toMatchObject({ calls: [], tasks: [] });
    expect((await b.api.getWatch({ name: 'watches/shop' })).health?.lastFailure).toBe(0);
    // Writes are open again.
    await b.api.pauseWatch({ name: 'watches/shop', requestId: op() });
  });

  it('an object the Worker no longer addresses keeps its data and stops its alarm', async () => {
    const h = await startHarness({ bindings: { DEV_MANUAL_ALARMS: 'false' } });
    try {
      // An API call arms an alarm on any object; the retired one's fires once and is never armed again.
      expect((await h.named('watch-v0', true)).alarm).not.toBeNull();
      const started = Date.now();
      while ((await h.named('watch-v0', false)).alarm !== null) {
        expect(Date.now() - started).toBeLessThan(15_000);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(h.logs).toContain('{"event":"retired"}');
      // The Worker's own object goes on: its alarm is armed again after it runs.
      await h.api.getServiceStatus({ name: 'serviceStatus' });
      const first = await h.alarmAt();
      expect(first).not.toBeNull();
      const until = Date.now();
      while ((await h.alarmAt()) === first) {
        expect(Date.now() - until).toBeLessThan(15_000);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(await h.alarmAt()).not.toBeNull();
    } finally {
      await h.dispose();
    }
  });
});
