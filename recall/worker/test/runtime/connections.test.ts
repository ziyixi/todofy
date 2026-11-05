import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batch, DEVICE, document, iso, page, uuid, visit } from './data.ts';
import { DAY, EXPORT_TOKEN, INGEST_TOKEN, machineReason, MINUTE, op, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';

const mask = { paths: ['label'] };

describe('connection labels and empty-device removal', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.dispose(); });

  it('renames named and shared credentials without changing their authentication or grace', async () => {
    const previous = await h.api.regenerateMachineToken({ name: 'machineTokens/ingest', requestId: op() });
    const current = await h.api.regenerateMachineToken({ name: 'machineTokens/ingest', requestId: op() });
    const named = await h.api.createMachineToken({ machineToken: { label: 'Phone' }, requestId: op() });
    const before = await h.sql<{ key: string; value: string }>(`SELECT key, value FROM meta WHERE key IN ('token_ingest', 'token_devices') ORDER BY key`);
    const requestId = op();
    const renamed = await h.api.updateMachineToken({ machineToken: { name: named.name, label: ' iPhone ' }, updateMask: mask, requestId });
    expect(renamed).toMatchObject({ name: named.name, label: 'iPhone', createTime: named.createTime, token: '' });
    const shared = await h.api.updateMachineToken({ machineToken: { name: current.name, label: 'Desktop shared' }, updateMask: mask, requestId: op() });
    expect(shared).toMatchObject({ label: 'Desktop shared', token: '', createTime: current.createTime, previousExpireTime: current.previousExpireTime });
    const after = await h.sql<{ key: string; value: string }>(`SELECT key, value FROM meta WHERE key IN ('token_ingest', 'token_devices') ORDER BY key`);
    expect(after.find((row) => row.key === 'token_ingest')?.value).toBe(before.find((row) => row.key === 'token_ingest')?.value);
    const storedBefore = JSON.parse(before.find((row) => row.key === 'token_devices')?.value ?? '[]') as Record<string, unknown>[];
    const storedAfter = JSON.parse(after.find((row) => row.key === 'token_devices')?.value ?? '[]') as Record<string, unknown>[];
    expect(storedAfter).toEqual(storedBefore.map((token) => token['id'] === named.name.split('/')[1] ? { ...token, label: 'iPhone' } : token));
    for (const token of [previous.token, current.token, named.token, INGEST_TOKEN]) expect((await h.upload(batch([]), { token })).status).toBe(200);
    await h.api.updateMachineToken({ machineToken: { name: named.name, label: 'Phone again' }, updateMask: mask, requestId: op() });
    expect(await h.api.updateMachineToken({ machineToken: { name: named.name, label: 'iPhone' }, updateMask: mask, requestId })).toMatchObject({ label: 'iPhone', token: '' });
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).machineTokens.find((token) => token.name === named.name)?.label).toBe('Phone again');
    const metadata = JSON.stringify(await h.sql(`SELECT * FROM meta`)) + JSON.stringify(await h.sql(`SELECT * FROM requests`));
    expect(metadata).not.toContain(named.token);
    expect(metadata).not.toContain(current.token);
  });

  it('names a Worker-secret route without creating or replacing its stored credential', async () => {
    const renamed = await h.api.updateMachineToken({ machineToken: { name: 'machineTokens/export', label: 'Archive reader' }, updateMask: mask, requestId: op() });
    expect(renamed).toMatchObject({ label: 'Archive reader', workerSecret: true, token: '' });
    expect(renamed.createTime).toBeUndefined();
    expect(await h.sql(`SELECT value FROM meta WHERE key = 'token_export'`)).toEqual([]);
    expect((await h.changes('?after=0', EXPORT_TOKEN)).status).toBe(200);
  });

  it('rejects missing or unsafe rename masks, invalid names and empty labels', async () => {
    for (const updateMask of [undefined, { paths: [] }, { paths: ['*'] }, { paths: ['token'] }, { paths: ['label', 'name'] }]) {
      expect(reasonOf(await rejection(h.api.updateMachineToken({ machineToken: { name: 'machineTokens/ingest', label: 'New' }, updateMask, requestId: op() })))).toBe('BAD_REQUEST');
    }
    for (const name of ['machineTokens/other', `machineTokens/${uuid(900)}`]) {
      expect(reasonOf(await rejection(h.api.updateMachineToken({ machineToken: { name, label: 'New' }, updateMask: mask, requestId: op() })))).toBe('NOT_FOUND');
    }
    expect(reasonOf(await rejection(h.api.updateMachineToken({ machineToken: { name: 'machineTokens/ingest', label: '  ' }, updateMask: mask, requestId: op() })))).toBe('BAD_REQUEST');
  });

  it('removes only empty connection metadata, and a replay cannot remove a later reconnection', async () => {
    const deviceId = uuid(201);
    expect((await h.upload(batch([], { device: { device_id: deviceId, label: 'Empty old install' } }))).status).toBe(200);
    const before = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(before.devices.find((device) => device.deviceId === deviceId)).toMatchObject({ hasRecords: false, queuedCount: 0 });
    const credential = await h.sql(`SELECT value FROM meta WHERE key = 'token_ingest'`);
    const requestId = op();
    await h.api.deleteDevice({ name: `devices/${deviceId}`, requestId });
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).devices.some((device) => device.deviceId === deviceId)).toBe(false);
    expect(await h.sql(`SELECT value FROM meta WHERE key = 'token_ingest'`)).toEqual(credential);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).headSeq).toBe(before.headSeq);
    await h.upload(batch([], { device: { device_id: deviceId } }));
    await h.api.deleteDevice({ name: `devices/${deviceId}`, requestId });
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).devices.some((device) => device.deviceId === deviceId)).toBe(true);
    expect(reasonOf(await rejection(h.api.deleteDevice({ name: 'devices/not-a-uuid', requestId: op() })))).toBe('BAD_REQUEST');
    expect(reasonOf(await rejection(h.api.deleteDevice({ name: `devices/${uuid(901)}`, requestId: op() })))).toBe('NOT_FOUND');
  });

  it('retains connections with visits, snapshot-only history or pending uploads and keeps history filterable', async () => {
    const visitDevice = uuid(202);
    const snapshotDevice = uuid(203);
    const queuedDevice = uuid(204);
    const url = 'https://example.org/old-device';
    await h.upload(batch([await visit({ id: uuid(302), url, spans: [[T0 - 2 * MINUTE, T0 - MINUTE]] })], { device: { device_id: visitDevice, label: 'Old computer' } }));
    await h.upload(batch([await document({ id: uuid(303), visitId: uuid(304), url, captureMs: T0 - MINUTE, text: 'Synthetic historical snapshot.' })], { device: { device_id: snapshotDevice, label: 'Snapshot-only computer' } }));
    await h.upload(batch([], { device: { device_id: queuedDevice, queued_count: 2 } }));
    const before = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(before.devices.find((device) => device.deviceId === visitDevice)?.hasRecords).toBe(true);
    expect(before.devices.find((device) => device.deviceId === snapshotDevice)?.hasRecords).toBe(true);
    expect(before.devices.find((device) => device.deviceId === queuedDevice)).toMatchObject({ hasRecords: false, queuedCount: 2 });
    for (const id of [visitDevice, snapshotDevice, queuedDevice]) expect(reasonOf(await rejection(h.api.deleteDevice({ name: `devices/${id}`, requestId: op() })))).toBe('DEVICE_NOT_EMPTY');
    const history = await h.api.listVisits({ parent: 'pages/-', deviceId: visitDevice });
    expect(history.visits.map((item) => item.deviceId)).toEqual([visitDevice]);
    const pageId = (await page(url)).pageId;
    expect((await h.api.getDocument({ name: `pages/${pageId}/documents/${uuid(303)}` })).text).toBe('Synthetic historical snapshot.');
    const after = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect([after.headSeq, after.visitCount, after.documentCount]).toEqual([before.headSeq, before.visitCount, before.documentCount]);
  });
});

// Independent devices share the archive and page identity, but retain separate visits and upload health.
const PHONE = '911e6d72-e917-4a44-a84e-1a6b3a8a0f11';
const SHARED_URL = 'https://example.com/shared-page';

describe('multiple browser devices', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    for (let i = 0; i < 6; i++) {
      const item = await visit({ id: uuid(i + 1), url: SHARED_URL, spans: [[T0 - (10 - i) * MINUTE, T0 - (9 - i) * MINUTE]] });
      const device = i % 2 === 0 ? DEVICE : { device_id: PHONE, label: 'iPhone', mobile: true };
      expect((await h.upload(batch([item], { device }))).status).toBe(200);
    }
  });
  afterAll(async () => { await h.dispose(); });

  it('filters every page and a single page with device-bound keyset pagination', async () => {
    const first = await h.api.listVisits({ parent: 'pages/-', deviceId: PHONE, pageSize: 2 });
    expect(first.visits).toHaveLength(2);
    expect(first.nextPageToken).not.toBe('');
    const second = await h.api.listVisits({ parent: 'pages/-', deviceId: PHONE, pageSize: 2, pageToken: first.nextPageToken });
    expect(second.visits).toHaveLength(1);
    expect(second.nextPageToken).toBe('');
    expect([...first.visits, ...second.visits].every((item) => item.deviceId === PHONE)).toBe(true);
    expect(new Set([...first.visits, ...second.visits].map((item) => item.name)).size).toBe(3);
    expect(reasonOf(await rejection(h.api.listVisits({ parent: 'pages/-', deviceId: DEVICE.device_id, pageToken: first.nextPageToken })))).toBe('BAD_REQUEST');
    expect(reasonOf(await rejection(h.api.listVisits({ parent: 'pages/-', pageToken: first.nextPageToken })))).toBe('BAD_REQUEST');
    expect(reasonOf(await rejection(h.api.listVisits({ parent: 'pages/-', deviceId: 'not-a-device' })))).toBe('BAD_REQUEST');
    const { pageId } = await page(SHARED_URL);
    const own = await h.api.listVisits({ parent: `pages/${pageId}`, deviceId: DEVICE.device_id });
    expect(own.visits).toHaveLength(3);
    expect(own.visits.every((item) => item.deviceId === DEVICE.device_id)).toBe(true);
    expect((await h.api.listVisits({ parent: 'pages/-' })).visits).toHaveLength(6);
  });

  it('reports mobile upload state without treating a day of inactivity as failure', async () => {
    await h.clock(T0 + 2 * DAY);
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.devices.find((item) => item.deviceId === PHONE)).toMatchObject({ mobile: true, stale: false, label: 'iPhone' });
    expect(status.devices.find((item) => item.deviceId === DEVICE.device_id)).toMatchObject({ mobile: false, stale: true });
    const signals = (await h.opsStatus())['signals'] as { code: string; metrics?: Record<string, number> }[];
    const stale = signals.find((item) => item.code === 'device_stale');
    expect(stale).toBeDefined();
    // Only the desktop is stale.
    expect(stale?.metrics?.['count']).toBe(1);
  });
});

// The one-shot report uses the existing authenticated heartbeat, never browsing rows, blobs or the archive feed.
const RUN = uuid(1, 4);
const DIAG_PHONE = uuid(2, 4);
const diagnostic = (runId = RUN) => ({
  run_id: runId,
  start_time: iso(T0 - MINUTE),
  report_time: iso(T0),
  tab_event_count: 3,
  alarm_event_count: 1,
  steps: [
    { stage: 'active_tabs', state: 'returned', result: 'array', count: 1, selection: 'test_page' },
    { stage: 'probe_reply', state: 'pending' },
  ],
});
const reportBatch = (report: unknown, items: readonly unknown[] = []) => ({ ...(batch(items) as object), diagnostic: report });

describe('one-shot capture diagnostic', () => {
  let h: Harness;
  beforeAll(async () => { h = await startHarness(); });
  afterAll(async () => { await h.dispose(); });

  it('keeps only the latest report while preserving browsing history and normal heartbeats', async () => {
    const url = 'https://example.com/diagnostic-history';
    const visitId = uuid(3, 4);
    const history = [
      await visit({ id: visitId, url, spans: [[T0 - 2 * MINUTE, T0 - MINUTE]] }),
      await document({ id: uuid(4, 4), visitId, url, captureMs: T0 - MINUTE, text: 'Synthetic page retained through diagnostic upload.' }),
    ];
    expect((await h.upload(batch(history))).status).toBe(200);
    const before = await h.api.getServiceStatus({ name: 'serviceStatus' });
    const beforeFeed = await (await h.changes()).json();
    const beforeBlobs = (await (await h.r2()).list()).objects.map((object) => object.key);

    const response = await h.upload(reportBatch(diagnostic()));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ accepted_count: 0, rejected: [] });
    const after = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(after.captureDiagnostic).toMatchObject({
      deviceId: DEVICE.device_id,
      diagnostic: { runId: RUN, tabEventCount: 3, alarmEventCount: 1, steps: [{ stage: 'active_tabs', selection: 'test_page' }, { stage: 'probe_reply', state: 'pending' }] },
    });
    expect(after.captureDiagnostic?.receiveTime).toEqual(timestampFromMs(T0));
    expect([after.headSeq, after.pageCount, after.visitCount, after.documentCount, after.blobStoredMib]).toEqual([
      before.headSeq, before.pageCount, before.visitCount, before.documentCount, before.blobStoredMib,
    ]);
    expect(await (await h.changes()).json()).toEqual(beforeFeed);
    expect((await (await h.r2()).list()).objects.map((object) => object.key)).toEqual(beforeBlobs);

    expect((await h.upload(batch([]))).status).toBe(200);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).captureDiagnostic).toEqual(after.captureDiagnostic);

    const latestRun = uuid(5, 4);
    await h.clock(T0 + MINUTE);
    expect((await h.upload({ ...(reportBatch(diagnostic(latestRun)) as object), device: { ...DEVICE, device_id: DIAG_PHONE, mobile: true } })).status).toBe(200);
    const latest = (await h.api.getServiceStatus({ name: 'serviceStatus' })).captureDiagnostic;
    expect(latest).toMatchObject({ deviceId: DIAG_PHONE, diagnostic: { runId: latestRun } });
    expect(latest?.receiveTime).toEqual(timestampFromMs(T0 + MINUTE));
    expect((await h.sql<{ n: number }>(`SELECT count(*) AS n FROM meta WHERE key = 'capture_diagnostic'`))[0]?.n).toBe(1);
  });

  it('rejects private fields, unbounded observations and reports mixed with browsing items before storing them', async () => {
    const good = diagnostic();
    const invalid = [
      { ...good, url: 'https://example.com/must-not-be-retained' },
      { ...good, steps: [{ stage: 'probe_reply', state: 'failed', error: 'must-not-be-retained' }] },
      { ...good, steps: [{ stage: 'probe_reply', state: 'failed', result: 'must-not-be-retained' }] },
      { ...good, steps: [{ stage: 'probe_reply', state: 'returned', count: 101 }] },
      { ...good, tab_event_count: 1001 },
      { ...good, alarm_event_count: -1 },
      { ...good, steps: Array.from({ length: 13 }, () => ({ stage: 'probe_reply', state: 'pending' })) },
      { ...good, steps: [{ stage: 'probe_reply', state: 'pending' }, { stage: 'probe_reply', state: 'returned' }] },
      { ...good, report_time: iso(T0 - 2 * MINUTE) },
    ];
    const before = (await h.api.getServiceStatus({ name: 'serviceStatus' })).captureDiagnostic;
    for (const report of invalid) {
      const response = await h.upload(reportBatch(report));
      expect(response.status).toBe(400);
      expect(await machineReason(response)).toBe('BAD_REQUEST');
    }
    expect((await h.upload(reportBatch(good, [await visit({ id: uuid(6, 4), url: 'https://example.org/no-diagnostic-visit', spans: [[T0 - MINUTE, T0]] })]))).status).toBe(400);
    expect((await h.upload(reportBatch(good), { token: null })).status).toBe(401);
    expect((await h.api.getServiceStatus({ name: 'serviceStatus' })).captureDiagnostic).toEqual(before);
    expect(JSON.stringify(await h.sql(`SELECT value FROM meta WHERE key = 'capture_diagnostic'`))).not.toContain('must-not-be-retained');
    expect(h.logs.join('\n')).not.toContain('must-not-be-retained');
  });
});

