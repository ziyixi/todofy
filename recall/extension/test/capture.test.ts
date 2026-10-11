// Captures: ten seconds of focus, then minute sampling, never for a page whose
// text recall does not keep, nothing from a page with a visible password field, a result of another build dropped,
// failures, the storage bound, and the text scrubbed and cut. Synthetic pages and texts only.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DOCUMENT_MAX_BYTES, utf8Bytes } from '../../shared/url.ts';
import { captureDelay, captureDue, readTab, storeCapture } from '../src/capture.ts';
import { reconcile } from '../src/focus.ts';
import { readPage, type PageText } from '../src/page-text.ts';
import { lastError } from '../src/store.ts';
import { harness, MINUTE, SECOND, T0, WINDOW_ID_NONE, type Harness } from './fake-chrome.ts';
import { queuedDocuments } from './helpers.ts';
import { compressScreenshot } from '../src/screenshot.ts';

vi.mock('../src/screenshot.ts', async (original) => ({ ...await original<typeof import('../src/screenshot.ts')>(), compressScreenshot: vi.fn() }));
beforeEach(() => vi.mocked(compressScreenshot).mockResolvedValue(null));

const ARTICLE = 'https://blog.example.com/2026/durable-objects-alarms';

/** A capture script's answer; its URL is the tab's (the fake browser fills it in) unless `url` names another. */
function pageText(overrides: Partial<PageText> = {}): Omit<PageText, 'url'> & { url?: string } {
  return {
    build: '2026.1010.900',
    title: 'Alarms in Durable Objects',
    description: 'How alarms wake an object.',
    text: '闹钟会唤醒对象。An alarm wakes the object.',
    textTruncated: false,
    hasPasswordField: false,
    ...overrides,
  };
}

/** Focuses a fresh tab on `url` at `at` and runs the capture at `at + 10 s`; answers the queued documents. */
async function captureAfterTenSeconds(h: Harness, url: string, at: number, text: ReturnType<typeof pageText> | Error = pageText()) {
  h.browser.script = () => {
    if (text instanceof Error) throw text;
    return text;
  };
  h.browser.open(url, { title: 'Alarms' });
  await reconcile(h.ctx, at);
  const job = await captureDue(h.ctx, at + 10 * SECOND);
  if (job !== null) await storeCapture(h.ctx, job, await readTab(h.ctx, job), at + 10 * SECOND);
  return { job, documents: await queuedDocuments(h.ctx) };
}

describe('when a page is captured', () => {
  it('at ten seconds of focus in a visit, counting earlier spans', async () => {
    const h = await harness();
    h.browser.open(ARTICLE);
    await reconcile(h.ctx, T0);
    expect(await captureDelay(h.ctx, T0)).toBe(10 * SECOND);
    expect(await captureDue(h.ctx, T0 + 4 * SECOND)).toBeNull();
    await reconcile(h.ctx, T0 + 4 * SECOND, { windowId: WINDOW_ID_NONE });
    expect(await captureDelay(h.ctx, T0 + 5 * SECOND)).toBeNull();
    await reconcile(h.ctx, T0 + MINUTE, { windowId: 1 });
    expect(await captureDelay(h.ctx, T0 + MINUTE)).toBe(6 * SECOND);
    expect(await captureDue(h.ctx, T0 + MINUTE + 6 * SECOND)).not.toBeNull();
  });

  it('injects capture.js into exactly the visit\'s document and queues its text', async () => {
    const h = await harness();
    const { job, documents } = await captureAfterTenSeconds(h, ARTICLE, T0);
    const tab = [...h.browser.tabs.values()][0];
    expect(h.browser.scriptCalls).toEqual([{ tabId: tab?.id, documentIds: [tab?.documentId], files: ['capture.js'] }]);
    expect(documents).toEqual([
      {
        id: expect.any(String) as string,
        visit_id: job?.visitId,
        page_id: job?.page.pageId,
        url: ARTICLE,
        title: 'Alarms in Durable Objects',
        description: 'How alarms wake an object.',
        capture_time: new Date(T0 + 10 * SECOND).toISOString(),
        text: '闹钟会唤醒对象。An alarm wakes the object.',
      },
    ]);
  });

  it('keeps changed text on the next minute, skips identical snapshots, and keeps another visit the same day', async () => {
    const h = await harness();
    await captureAfterTenSeconds(h, ARTICLE, T0);
    const sample = async (at: number, body: string) => {
      h.browser.script = () => pageText({ text: body });
      const job = await captureDue(h.ctx, at);
      expect(job).not.toBeNull();
      if (job !== null) await storeCapture(h.ctx, job, await readTab(h.ctx, job), at);
    };
    await sample(T0 + MINUTE, 'The page changed today.');
    await sample(T0 + 2 * MINUTE, 'The page changed today.');
    expect((await queuedDocuments(h.ctx)).map((doc) => doc.text)).toEqual(['闹钟会唤醒对象。An alarm wakes the object.', 'The page changed today.']);
    const again = await captureAfterTenSeconds(h, ARTICLE, T0 + 3 * MINUTE);
    expect(again.documents).toHaveLength(3);
  });

  it('keeps a changed screenshot even when the text is unchanged, including an image-only page', async () => {
    const h = await harness();
    h.browser.screenshot = 'data:image/png;base64,synthetic';
    vi.mocked(compressScreenshot).mockResolvedValue({ base64: 'cGljdHVyZS0x', preview: '800x600:' + btoa('a'.repeat(4096)), width: 800, height: 600 });
    await captureAfterTenSeconds(h, ARTICLE, T0);
    vi.mocked(compressScreenshot).mockResolvedValue({ base64: 'clock-tick', preview: '800x600:' + btoa('z'.repeat(40) + 'a'.repeat(4056)), width: 800, height: 600 });
    const clockJob = await captureDue(h.ctx, T0 + MINUTE);
    if (clockJob !== null) await storeCapture(h.ctx, clockJob, await readTab(h.ctx, clockJob), T0 + MINUTE);
    expect(await queuedDocuments(h.ctx)).toHaveLength(1);
    vi.mocked(compressScreenshot).mockResolvedValue({ base64: 'cGljdHVyZS0y', preview: '800x600:' + btoa('z'.repeat(4096)), width: 800, height: 600 });
    const job = await captureDue(h.ctx, T0 + 2 * MINUTE);
    if (job !== null) await storeCapture(h.ctx, job, await readTab(h.ctx, job), T0 + 2 * MINUTE);
    expect((await queuedDocuments(h.ctx)).map((doc) => doc.screenshot_webp_base64)).toEqual(['cGljdHVyZS0x', 'cGljdHVyZS0y']);
    const imageOnly = await captureAfterTenSeconds(h, 'https://example.org/gallery', T0 + 3 * MINUTE, pageText({ text: '' }));
    expect(imageOnly.documents.at(-1)).toMatchObject({ text: '', screenshot_webp_base64: 'cGljdHVyZS0y' });
  });

  it('never for a page whose text recall does not keep', async () => {
    for (const url of [
      'https://mail.google.com/mail/u/0/#inbox',
      'https://home.ziyixi.science/',
      'https://shop.example.com/account/login',
      'https://example.org/oauth2/authorize?client_id=x',
    ]) {
      const h = await harness();
      h.browser.open(url);
      await reconcile(h.ctx, T0);
      expect(await captureDelay(h.ctx, T0), url).toBeNull();
      expect(await captureDue(h.ctx, T0 + MINUTE), url).toBeNull();
    }
  });
});

describe('what a capture keeps', () => {
  it('nothing from a page with a visible password field, including its screenshot', async () => {
    const h = await harness();
    const { documents } = await captureAfterTenSeconds(h, ARTICLE, T0, pageText({ hasPasswordField: true, text: 'Sign in to example.com' }));
    expect(documents).toEqual([]);
    expect(h.browser.screenshotCalls).toBe(0);
  });

  it('the text scrubbed and cut again, with its truncation flag', async () => {
    const h = await harness();
    const secret = `ghp_${'a1B2'.repeat(9)}`;
    const long = `token ${secret} ${'数据库'.repeat(30_000)}`;
    const { documents } = await captureAfterTenSeconds(h, ARTICLE, T0, pageText({ text: long, title: `Deploy key ${secret}`, description: 'password=hunter22' }));
    const [document] = documents;
    expect(document?.text.startsWith('token [redacted] 数据库')).toBe(true);
    expect(utf8Bytes(document?.text ?? '')).toBeLessThanOrEqual(DOCUMENT_MAX_BYTES);
    expect(document?.text_truncated).toBe(true);
    expect(document?.title).toBe('Deploy key [redacted]');
    expect(document?.description).toBe('password=[redacted]');
  });

  it('a text cut by the page script keeps its flag', async () => {
    const h = await harness();
    const { documents } = await captureAfterTenSeconds(h, ARTICLE, T0, pageText({ textTruncated: true }));
    expect(documents[0]?.text_truncated).toBe(true);
  });

  it.each(['empty', 'failure'])('a %s first attempt does not block the next minute from saving content', async (first) => {
    const h = await harness();
    await captureAfterTenSeconds(h, ARTICLE, T0, first === 'empty' ? pageText({ text: ' \n\t ' }) : new Error('Synthetic failure'));
    expect(await queuedDocuments(h.ctx)).toEqual([]);
    h.browser.script = () => pageText({ text: 'Content available on the next tick.' });
    const job = await captureDue(h.ctx, T0 + MINUTE);
    if (job !== null) await storeCapture(h.ctx, job, await readTab(h.ctx, job), T0 + MINUTE);
    expect((await queuedDocuments(h.ctx)).map((doc) => doc.text)).toEqual(['Content available on the next tick.']);
  });

  it('nothing from a capture script of another build (the worker reloads within the minute)', async () => {
    const h = await harness();
    const { documents } = await captureAfterTenSeconds(h, ARTICLE, T0, pageText({ build: '2026.1009.100' }));
    expect(documents).toEqual([]);

  });
});

describe('a capture that cannot run', () => {
  it('a failure is the device\'s capture_failed', async () => {
    const h = await harness();
    await captureAfterTenSeconds(h, ARTICLE, T0, new Error('Frame with ID 0 was removed.'));
    expect(await lastError.get(h.ctx.chrome)).toEqual({ code: 'capture_failed', at: T0 + 10 * SECOND });
  });

  it('a malformed result is a failure too', async () => {
    const h = await harness();
    h.browser.script = () => ({ title: 1 });
    h.browser.open(ARTICLE);
    await reconcile(h.ctx, T0);
    const job = await captureDue(h.ctx, T0 + 10 * SECOND);
    expect(job && (await readTab(h.ctx, job))).toEqual({ kind: 'failed' });
  });

  it('a page Chrome does not let an extension script is a visit without text, not an error', async () => {
    const h = await harness();
    await captureAfterTenSeconds(h, 'https://chromewebstore.google.com/detail/example', T0, new Error('The extensions gallery cannot be scripted.'));
    await captureAfterTenSeconds(h, 'https://docs.example.com/report.pdf', T0 + MINUTE, new Error('Cannot access contents of the page.'));
    expect(await lastError.get(h.ctx.chrome)).toBeNull();
    expect(await queuedDocuments(h.ctx)).toEqual([]);
  });

  it('past 200 MB of storage it stops capturing (visits continue), and says outbox_full', async () => {
    const h = await harness({ storageUsage: 250_000_000 });
    const { job } = await captureAfterTenSeconds(h, ARTICLE, T0);
    expect(job).toBeNull();
    expect((await lastError.get(h.ctx.chrome))?.code).toBe('outbox_full');
  });
});

/** A minimal document for readPage: elements with the attributes and visibility it asks for. */
function fakeDocument(options: { title?: string; body?: string | null; description?: string; passwordFields?: boolean[] }): Document {
  const fields = (options.passwordFields ?? []).map((visible) => ({ checkVisibility: () => visible }));
  return {
    title: options.title ?? 'A page',
    location: { href: 'https://blog.example.com/a' },
    querySelectorAll: (selector: string) => (selector.includes('password') ? fields : []),
    querySelector: (selector: string) => {
      if (selector.startsWith('meta')) return options.description === undefined ? null : { getAttribute: () => options.description };
      if (selector === 'body') return options.body === null || options.body === undefined ? null : { innerText: options.body };
      return null;
    },
  } as unknown as Document;
}

describe('a capture after an SPA moved the document', () => {
  it('keeps no text the script read on another route of the same document', async () => {
    const h = await harness();
    // The capture was claimed for the article; the page moved (pushState) to a sign-in route before it ran.
    const { documents } = await captureAfterTenSeconds(h, ARTICLE, T0, pageText({ url: 'https://blog.example.com/account/login', text: 'Your one-time code' }));
    expect(documents).toEqual([]);
    const other = await captureAfterTenSeconds(h, 'https://blog.example.com/a', T0 + MINUTE, pageText({ url: 'https://blog.example.com/b' }));
    expect(other.documents).toEqual([]);
    // The same page with another fragment is the same page.
    const same = await captureAfterTenSeconds(h, 'https://blog.example.com/c', T0 + 2 * MINUTE, pageText({ url: 'https://blog.example.com/c#comments' }));
    expect(same.documents).toHaveLength(1);
  });
});

describe('readPage (the capture script)', () => {
  it('reads the title, the meta description and the body\'s innerText', () => {
    expect(readPage(fakeDocument({ title: 'T', description: 'D', body: '正文 text' }), 'b1')).toEqual({
      build: 'b1',
      url: 'https://blog.example.com/a',
      title: 'T',
      description: 'D',
      text: '正文 text',
      textTruncated: false,
      hasPasswordField: false,
    });
  });

  it('reads no text beside a visible password field, and ignores a hidden one', () => {
    expect(readPage(fakeDocument({ body: 'sign in', passwordFields: [false, true] }), 'b1')).toMatchObject({ text: '', hasPasswordField: true });
    expect(readPage(fakeDocument({ body: 'sign in', passwordFields: [false] }), 'b1')).toMatchObject({ text: 'sign in', hasPasswordField: false });
  });

  it('cuts the text to 64 KiB of UTF-8 at a character boundary, and reads a document without a body as empty', () => {
    const read = readPage(fakeDocument({ body: '😀'.repeat(20_000) }), 'b1');
    expect(read.textTruncated).toBe(true);
    expect(utf8Bytes(read.text)).toBe(DOCUMENT_MAX_BYTES);
    expect(readPage(fakeDocument({ body: null }), 'b1')).toMatchObject({ text: '', description: '' });
  });
});
