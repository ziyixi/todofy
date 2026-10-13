import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batch, document, page, uuid, visit } from './data.ts';
import { EXPORT_TOKEN, INGEST_TOKEN, MINUTE, op, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';

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
