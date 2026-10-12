// The one-shot report uses the existing authenticated heartbeat, never browsing rows, blobs or the archive feed.
import { timestampFromMs } from '@ziyixi/proto/protobuf/wkt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batch, DEVICE, document, iso, uuid, visit } from './data.ts';
import { machineReason, MINUTE, startHarness, T0, type Harness } from './harness.ts';

const RUN = uuid(1, 4);
const PHONE = uuid(2, 4);
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
    expect((await h.upload({ ...(reportBatch(diagnostic(latestRun)) as object), device: { ...DEVICE, device_id: PHONE, mobile: true } })).status).toBe(200);
    const latest = (await h.api.getServiceStatus({ name: 'serviceStatus' })).captureDiagnostic;
    expect(latest).toMatchObject({ deviceId: PHONE, diagnostic: { runId: latestRun } });
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
