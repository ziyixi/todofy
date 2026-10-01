/**
 * PreviewWatch in workerd (../../../docs/design.md §5, §9): every stage's output for the phone's block picker, the
 * selectors of its blocks working as include and exclude selectors (HTMLRewriter's own matching), the fetch cache,
 * a refresh within the host's spacing, and stages 4 and 5 against an existing watch.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FailureReason } from '@ziyixi/proto/watch/ui/v1/watch_pb';
import { page, rss } from '../fake-sites.ts';
import { HOUR, op, resetWatches, startHarness, T0, type Harness } from './harness.ts';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await resetWatches(h);
});

afterAll(async () => {
  await h.dispose();
});

const SHOP = page(
  'Shop',
  `<section class="product"><h1>Synthetic tea kettle</h1><p>Price: ¥1,299.00</p><p>Updated 5 minutes ago</p></section>
   <section id="reviews"><h2>Reviews</h2><p>Great kettle, would buy again.</p><p>Boils fast.</p></section>
   <div><p>Recommended for you: a synthetic mug</p></div>`,
);

describe('PreviewWatch', () => {
  it('answers the fetch, the blocks, the extracted and normalized lines and the number, without storing a watch', async () => {
    const url = 'https://preview.example.com/item';
    h.sites.html(url, SHOP);
    const preview = await h.api.previewWatch({ watch: { displayName: 'p', uri: url, trigger: { number: { label: 'Price:', upperThreshold: 2000 } } } });
    expect(preview.failure).toBe(FailureReason.UNSPECIFIED);
    expect(preview.fetch).toMatchObject({ httpStatus: 200, mimeType: 'text/html', finalUri: url, charset: 'utf-8', robotsAllowed: true, cached: false, markdown: false });
    expect(preview.numberValue).toBe('1,299.00');
    expect(preview.extractedLines).toContain('Updated 5 minutes ago');
    expect(preview.normalizedLines).toContain('Updated ⟨相对时间⟩');
    expect(preview.maskedTokenCount).toBeGreaterThanOrEqual(1);
    const landmark = preview.blocks.find((block) => block.text.includes('Menu A'));
    expect(landmark?.landmark).toBe(true);
    expect(landmark?.counted).toBe(false);
    expect(await h.sql('SELECT id FROM watches')).toEqual([]);
  });

  it("a block's selector works as an include selector, and as an exclude selector", async () => {
    const url = 'https://picker.example.com/item';
    h.sites.html(url, SHOP);
    const first = await h.api.previewWatch({ watch: { displayName: 'p', uri: url } });
    const reviews = first.blocks.find((block) => block.text.includes('Great kettle'));
    const recommended = first.blocks.find((block) => block.text.includes('Recommended'));
    expect(reviews?.selector).toBe('section#reviews > p:nth-of-type(1)');
    // Include: only that block.
    const include = await h.api.previewWatch({ watch: { displayName: 'p', uri: url, source: { html: { includeSelectors: [reviews?.selector ?? ''] } } } });
    expect(include.fetch?.cached).toBe(true);
    expect(include.normalizedLines).toEqual(['Great kettle, would buy again.']);
    // Exclude: everything but that block.
    const exclude = await h.api.previewWatch({ watch: { displayName: 'p', uri: url, source: { html: { excludeSelectors: [recommended?.selector ?? ''] } } } });
    expect(exclude.normalizedLines.some((line) => line.includes('Recommended'))).toBe(false);
    expect(exclude.normalizedLines).toContain('Boils fast.');
    expect(exclude.blocks.find((block) => block.text.includes('Recommended'))?.counted).toBe(false);
    // One fetch for the three previews (robots.txt and the page).
    expect(h.sites.requestsTo(url)).toHaveLength(1);
  });

  it('refresh fetches again after the host\'s spacing; a feed preview lists items with their keys', async () => {
    const url = 'https://refresh.example.com/item';
    h.sites.html(url, SHOP);
    await h.api.previewWatch({ watch: { displayName: 'p', uri: url } });
    const again = await h.api.previewWatch({ watch: { displayName: 'p', uri: url }, refresh: true });
    expect(again.fetch?.cached).toBe(false);
    // The test clock moved by the spacing the preview waited for.
    expect(Number(again.fetch?.fetchTime?.seconds) * 1000).toBeGreaterThanOrEqual(T0 + 30_000);
    expect(h.sites.requestsTo(url)).toHaveLength(2);
    await h.clock(T0);

    const feed = 'https://feeds.example.org/rss';
    h.sites.set(feed, { headers: { 'content-type': 'application/rss+xml' }, body: rss([{ guid: 'g-1', title: 'Hello', link: 'https://feeds.example.org/1' }]) });
    const items = await h.api.previewWatch({ watch: { displayName: 'f', uri: feed, source: { feed: {} } } });
    expect(items.items.map((item) => [item.key, item.text])).toEqual([['g-1', 'Hello — https://feeds.example.org/1']]);
  });

  it('compares with an existing watch: what the trigger would say now', async () => {
    const url = 'https://compare.example.com/item';
    h.sites.html(url, page('C', '<p>Status: sold out</p><p>Come back later for the synthetic item.</p>'));
    await h.api.createWatch({ watchId: 'cmp', requestId: op(), watch: { displayName: 'c', uri: url, trigger: { textAppears: { text: 'in stock' } } } });
    await h.run(T0);
    h.sites.html(url, page('C', '<p>Status: in stock</p><p>Come back later for the synthetic item.</p>'));
    await h.clock(T0 + HOUR);
    const watch = await h.api.getWatch({ name: 'watches/cmp' });
    const preview = await h.api.previewWatch({ watch, refresh: true });
    expect(preview.trigger?.fired).toBe(true);
    expect(preview.trigger?.addedLineCount).toBe(1);
    expect(preview.trigger?.diffLines.map((line) => line.text)).toEqual(['Status: sold out', 'Status: in stock']);
  });

  it('shows a failure of the health gate as its code, and refuses a host that asked to back off without fetching', async () => {
    const url = 'https://backoff.example.com/p';
    h.sites.set(url, { status: 429, headers: { 'retry-after': '3600' }, body: '' });
    const limited = await h.api.previewWatch({ watch: { displayName: 'b', uri: url } });
    expect(limited.failure).toBe(FailureReason.RATE_LIMITED);
    const again = await h.api.previewWatch({ watch: { displayName: 'b', uri: url }, refresh: true });
    expect(again.failure).toBe(FailureReason.RATE_LIMITED);
    expect(h.sites.requestsTo(url)).toHaveLength(1);
  });
});
