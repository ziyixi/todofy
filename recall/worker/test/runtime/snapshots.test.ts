// Real DO/R2: changed visual samples share the existing Document and feed, with history metadata separate from bytes.
import { expect, it } from 'vitest';
import { batch, document, page, uuid, WEBP, type ChangePage } from './data.ts';
import { MINUTE, startHarness, T0 } from './harness.ts';

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
