// Real DO/R2: changed visual samples share the existing Document and feed, with history metadata separate from bytes.
import { expect, it } from 'vitest';
import { batch, document, page, uuid, WEBP, JPEG, type ChangePage } from './data.ts';
import { DAY, MINUTE, op, startHarness, T0 } from './harness.ts';
import { FakeDropbox } from './fake-dropbox.ts';

it('keeps screenshot snapshots, skips consecutive duplicates, and keeps text searchable after an image-only capture', async () => {
  const h = await startHarness();
  try {
    const url = 'https://example.org/canvas';
    const capture = (id: number, text: string, screenshot?: string) => document({ id: uuid(id), visitId: uuid(90), url, captureMs: T0 - (10 - id) * MINUTE, text, ...(screenshot === undefined ? {} : { screenshot }) });
    const response = await h.upload(batch([
      await capture(1, 'Synthetic searchable text: zephyr.'),
      await capture(2, 'Synthetic searchable text: zephyr.', WEBP),
      await capture(3, 'Synthetic searchable text: zephyr.', WEBP),
      await capture(4, '', WEBP),
    ]));
    expect(await response.json()).toMatchObject({ accepted_count: 4, rejected: [] });
    const parent = `pages/${(await page(url)).pageId}`;
    expect((await h.api.getPage({ name: parent })).documentCount).toBe(3);
    expect((await h.api.searchPages({ query: 'zephyr' })).results.map((result) => result.page)).toEqual([parent]);
    const first = await h.api.listDocuments({ parent, pageSize: 2 });
    expect(first.documents.map((item) => item.name)).toEqual([`${parent}/documents/${uuid(4)}`, `${parent}/documents/${uuid(2)}`]);
    expect(first.documents.every((item) => item.text === '' && item.screenshotWebpBase64 === '')).toBe(true);
    const rest = await h.api.listDocuments({ parent, pageSize: 2, pageToken: first.nextPageToken });
    expect(rest.documents.map((item) => item.name)).toEqual([`${parent}/documents/${uuid(1)}`]);
    expect(rest.nextPageToken).toBe('');
    const selected = first.documents[0];
    if (selected === undefined) throw new Error('snapshot missing');
    expect(await h.api.getDocument({ name: selected.name })).toMatchObject({ text: '', screenshotWebpBase64: WEBP, screenshotWidth: 1, screenshotHeight: 1, contentError: '' });
    const feed = await (await h.changes('?after=0')).json<ChangePage>();
    const archivedSnapshot = feed.changes.find((item) => item.id === `documents/${uuid(2)}`);
    expect(archivedSnapshot?.document).toMatchObject({ screenshot_width: 1, screenshot_height: 1 });
    const image = archivedSnapshot?.blobs.find((blob) => blob.role === 'screenshot');
    if (image === undefined) throw new Error('screenshot not in feed');
    expect(image).toMatchObject({ path: `2026/10/${uuid(2)}.webp`, media_type: 'image/webp' });
    const r2 = await h.r2();
    const stored = await r2.get(`blobs/${image.path}`);
    if (stored === null) throw new Error('screenshot not in R2');
    expect(new Uint8Array(await stored.arrayBuffer())).toEqual(Uint8Array.from(atob(WEBP), (byte) => byte.charCodeAt(0)));
    expect(await r2.head(`blobs/2026/10/${uuid(3)}.webp`)).toBeNull();
  } finally {
    await h.dispose();
  }
});


it('archives both devices together and reads JPEG and WebP after the hot window expires', async () => {
  const dropbox = new FakeDropbox();
  const h = await startHarness({ outbound: (request) => dropbox.handle(request) });
  try {
    const url = 'https://example.org/multiple-devices';
    for (const [id, image, mediaType, label] of [[101, WEBP, 'image/webp', 'Desktop'], [102, JPEG, 'image/jpeg', 'Phone']] as const) {
      const item = await document({ id: uuid(id), visitId: uuid(id + 10), url, captureMs: T0 - MINUTE, text: 'Synthetic shared page zephyr.', screenshot: image, screenshotMediaType: mediaType });
      const response = await h.upload(batch([item], { device: { device_id: uuid(id + 20), label, ...(label === 'Phone' ? { mobile: true } : {}) } }));
      expect(await response.json()).toMatchObject({ accepted_count: 1, rejected: [] });
    }
    const parent = `pages/${(await page(url)).pageId}`;
    expect((await h.api.getPage({ name: parent })).documentCount).toBe(2);
    const { authorizeUrl } = await h.api.connectDropboxBackup({ name: 'dropboxBackup', appKey: dropbox.appKey, requestId: op() });
    expect((await h.fetch(`/api/dropbox/callback${dropbox.approve(authorizeUrl).query}`)).status).toBe(303);
    const later = T0 + 8 * DAY;
    await h.clock(later);
    await h.step(later);
    for (const [id, image, suffix, field] of [[101, WEBP, 'webp', 'screenshotWebpBase64'], [102, JPEG, 'jpg', 'screenshotJpegBase64']] as const) {
      const path = `blobs/2026/10/${uuid(id)}.${suffix}`;
      expect(dropbox.files.has(`/${path}`)).toBe(true);
      expect(await (await h.r2()).head(path)).toBeNull();
      expect(await h.api.getDocument({ name: `${parent}/documents/${uuid(id)}` })).toMatchObject({ textArchived: true, [field]: image, contentError: '' });
    }
    expect((await h.api.searchPages({ query: 'zephyr' })).results.map((item) => item.page)).toEqual([parent]);
    const days = [...dropbox.files.entries()].filter(([path]) => path.startsWith('/changes/')).map(([, bytes]) => new TextDecoder().decode(bytes)).join('');
    expect(days).toContain('"device_label":"Desktop"');
    expect(days).toContain('"device_label":"Phone"');
    expect(days).toContain('"media_type":"image/jpeg"');
  } finally {
    await h.dispose();
  }
});
