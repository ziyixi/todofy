/**
 * The extension's part of recall's smoke run (../../worker/test/smoke/smoke.mts, ../../docs/design.md §10): the
 * extension's own code, under the fake chrome.* of fake-chrome.ts, records a short browsing session and uploads it to
 * a real recall (`wrangler dev` on loopback). Only the network is real: the fake fetch forwards each request for
 * recall's public origin to RECALL_SMOKE_ORIGIN, and the answer goes back through the extension's own reading of it.
 *
 * The session, seven minutes ending now: an article read long enough for its text (with a secret in it), a page on a
 * site the owner's denylist keeps without text (the extension does not know the list yet, so it uploads the text and
 * recall must drop it), a page with a URL over 8192 characters, a mail page (site only), a page on a host with an
 * underscore and one on a host written with a trailing dot; then the focus leaves Chrome. One flush uploads the
 * outbox, a second one with an empty outbox is the heartbeat.
 *
 * It prints one JSON line: each batch it sent (wire JSON), each flush's outcome, and the extension's state afterwards
 * (the outbox's size, the upload state, the owner's denylist as recall answered it). Synthetic pages and token only.
 *
 *   RECALL_SMOKE_ORIGIN=http://127.0.0.1:8797 RECALL_SMOKE_INGEST_TOKEN=recall_ingest_... node test/smoke-upload.ts
 */
import { captureDue, readTab, storeCapture } from '../src/capture.ts';
import { countItems, setToken } from '../src/db.ts';
import { reconcile } from '../src/focus.ts';
import { DEFAULT_SERVER, ownerDenylist, setDevice, uploadState } from '../src/store.ts';
import { flush } from '../src/upload.ts';
import { harness, MINUTE, SECOND, WINDOW_ID_NONE, type FakeRequest, type Harness } from './fake-chrome.ts';

/** The synthetic pages of the session: what Chrome shows and what the capture script reads. */
const PAGES = {
  article: {
    url: 'https://news.example.org/2026/10/sqlite-fts5-chinese?utm_source=feed',
    title: 'SQLite FTS5 与中文分词',
    description: '二元分词与短语查询',
    text: '数据库的全文检索需要中文分词。二元分词把每两个相邻的汉字当作一个词。 api_key=abcdef1234567890 Durable Object storage.',
  },
  denied: {
    url: 'https://notes.example.net/2026/private-plan',
    title: 'Private plan',
    description: '',
    text: 'A synthetic page whose text the owner keeps out of recall.',
  },
  map: { url: `https://maps.example.com/?view=${'x'.repeat(9000)}`, title: 'Map' },
  mail: { url: 'https://mail.google.com/mail/u/0/#inbox', title: 'Inbox (2)' },
  team: { url: 'https://my_team.example.com/wiki/onboarding', title: 'Onboarding' },
  dotted: { url: 'https://guides.example.com./alarms', title: 'Alarms guide' },
} as const;

/** A request for recall's public origin, sent to the local recall instead. */
async function forward(origin: string, request: FakeRequest): Promise<Response> {
  const url = new URL(request.url);
  if (url.origin !== DEFAULT_SERVER) throw new TypeError(`smoke: a request to another origin than recall's`);
  return fetch(new URL(url.pathname + url.search, origin), request.init);
}

/** The gzip body of an upload as the JSON it carries. */
async function sentJson(request: FakeRequest): Promise<unknown> {
  const body = request.init.body;
  if (!(body instanceof ArrayBuffer)) throw new TypeError('smoke: an upload without a gzip body');
  return JSON.parse(await new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))).text()) as unknown;
}

/** Focus on a new tab showing `page` at `at`, and its text captured ten seconds later when it has one. */
async function visit(h: Harness, page: { url: string; title: string; description?: string; text?: string }, at: number): Promise<void> {
  h.browser.script = () => ({ build: h.ctx.build, title: page.title, description: page.description ?? '', text: page.text ?? '', textTruncated: false, hasPasswordField: false });
  h.browser.open(page.url, { title: page.title });
  await reconcile(h.ctx, at);
  if (page.text === undefined) return;
  const job = await captureDue(h.ctx, at + 10 * SECOND);
  if (job === null) throw new Error('smoke: the capture did not come due');
  await storeCapture(h.ctx, job, await readTab(h.ctx, job), at + 10 * SECOND);
}

async function main(): Promise<void> {
  const origin = process.env['RECALL_SMOKE_ORIGIN'] ?? '';
  const token = process.env['RECALL_SMOKE_INGEST_TOKEN'] ?? '';
  if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(origin) || !token.startsWith('recall_ingest_')) throw new Error('smoke: set RECALL_SMOKE_ORIGIN (loopback) and RECALL_SMOKE_INGEST_TOKEN');

  const h = await harness();
  const start = Date.now() - 7 * MINUTE;
  await setDevice(h.ctx.chrome, { id: h.ctx.uuid(), label: 'MacBook · 冒烟', server: DEFAULT_SERVER });
  await visit(h, PAGES.article, start);
  await visit(h, PAGES.denied, start + MINUTE);
  await visit(h, PAGES.map, start + 2 * MINUTE);
  await visit(h, PAGES.mail, start + 3 * MINUTE);
  await visit(h, PAGES.team, start + 4 * MINUTE);
  await visit(h, PAGES.dotted, start + 5 * MINUTE);
  await reconcile(h.ctx, start + 6 * MINUTE, { windowId: WINDOW_ID_NONE });

  await setToken(h.ctx.db, token);
  h.net.answer = (request) => forward(origin, request);
  h.clock.time = start + 7 * MINUTE;
  const upload = await flush(h.ctx, h.clock.time, 'manual');
  const heartbeat = await flush(h.ctx, h.clock.time, 'manual');

  console.log(
    JSON.stringify({
      outcomes: [upload, heartbeat],
      sent: await Promise.all(h.net.requests.map(sentJson)),
      outbox: await countItems(h.ctx.db),
      upload: await uploadState.get(h.ctx.chrome),
      denylist: await ownerDenylist.get(h.ctx.chrome),
    }),
  );
}

await main();
