import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHttpClient, RpcStatusError } from '@ziyixi/proto/http-client';
import { RecallUiService } from '@ziyixi/proto/recall/ui/v1/recall_ui_service_pb';
import { batch, document, page, uuid, visit } from './data.ts';
import { MINUTE, startHarness, T0, type Harness } from './harness.ts';

describe('the private RecallApi binding', () => {
  let h: Harness;
  const url = 'https://docs.example.com/synthetic-notes';
  beforeAll(async () => {
    h = await startHarness();
    expect((await h.upload(batch([
      await visit({ id: uuid(1), url, title: 'Synthetic notes', spans: [[T0 - 2 * MINUTE, T0 - MINUTE]] }),
      await document({ id: uuid(2), visitId: uuid(1), url, captureMs: T0 - 90_000, text: 'Synthetic archive word zephyr.' }),
    ], { sentMs: T0 }))).status).toBe(200);
  });
  afterAll(async () => { await h.dispose(); });

  const client = () => createHttpClient(RecallUiService, call => h.serviceFetch(call.url, {
    method: call.httpMethod, ...(call.body === undefined ? {} : { body: call.body, headers: { 'content-type': 'application/json' } }),
  }));

  it('reuses the generated page, snapshot and activity reads without owner or machine credentials', async () => {
    const api = client();
    const found = await api.searchPages({ query: 'zephyr' });
    expect(found.results).toHaveLength(1);
    const { pageId } = await page(url);
    const metadata = await api.getPage({ name: `pages/${pageId}` });
    const snapshots = await api.listDocuments({ parent: metadata.name });
    expect(snapshots.documents).toHaveLength(1);
    expect(await api.getDocument({ name: snapshots.documents[0]?.name ?? '' })).toMatchObject({ text: 'Synthetic archive word zephyr.', contentError: '' });
    const activity = await api.listVisits({ parent: 'pages/-', orderBy: 'start_time desc', pageSize: 1 });
    expect(activity.visits).toHaveLength(1);
    expect(activity.visits[0]?.url).toBe(url);
    const response = await h.serviceFetch(`/api/v1/pages/${pageId}`);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(h.logs.join('\n')).not.toContain(url);
    expect(h.logs.join('\n')).not.toContain('Synthetic archive word');
  });

  it('does not grant the other owner reads, writes, machine routes or public unauthenticated reads', async () => {
    for (const path of ['/api/v1/settings', '/api/v1/serviceStatus', '/api/v1/pages/-/unknown', '/api/machine/v1/changes']) {
      expect((await h.serviceFetch(path)).status, path).toBe(404);
    }
    const { pageId } = await page(url);
    for (const method of ['POST', 'DELETE', 'HEAD', 'OPTIONS']) {
      const response = await h.serviceFetch(`/api/v1/pages/${pageId}`, { method });
      expect(response.status, method).toBe(405);
      expect(response.headers.get('allow')).toBe('GET');
    }
    const error = await client().getSettings({ name: 'settings' }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(RpcStatusError);
    expect((error as RpcStatusError).status.reason).toBe('NOT_FOUND');
    // A request from the edge cannot use the loopback fixture's dev bypass.
    const publicRead = await h.fetch('/api/v1/pages:search', { headers: { 'cf-ray': 'synthetic-edge-request' } });
    expect(publicRead.status).toBe(503);
    expect(await publicRead.text()).toContain('ACCESS_NOT_CONFIGURED');
    expect((await client().getPage({ name: `pages/${pageId}` })).documentCount).toBe(1);
  });
});
