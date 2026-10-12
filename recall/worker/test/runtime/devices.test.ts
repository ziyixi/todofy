// Independent devices share the archive and page identity, but retain separate visits and upload health.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batch, DEVICE, page, uuid, visit } from './data.ts';
import { DAY, MINUTE, reasonOf, rejection, startHarness, T0, type Harness } from './harness.ts';

const PHONE = '911e6d72-e917-4a44-a84e-1a6b3a8a0f11';
const URL = 'https://example.com/shared-page';

describe('multiple browser devices', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
    for (let i = 0; i < 6; i++) {
      const item = await visit({ id: uuid(i + 1), url: URL, spans: [[T0 - (10 - i) * MINUTE, T0 - (9 - i) * MINUTE]] });
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
    const { pageId } = await page(URL);
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
