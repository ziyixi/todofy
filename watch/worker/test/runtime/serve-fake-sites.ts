/**
 * Synthetic websites on a loopback port, for trying the UI with `wrangler dev` (../../README.md "Develop"): set
 * DEV_FAKE_UPSTREAM=http://127.0.0.1:8792 in ../../.dev.vars and every page request of the Worker comes here (with
 * its original URL in `x-watch-original-url`), never to the internet.
 *
 *   node test/runtime/serve-fake-sites.ts [port]                     (from worker/; Node's type stripping runs it)
 *   curl -X POST http://127.0.0.1:8792/__next               (every site moves to its next version)
 *   curl -X POST 'http://127.0.0.1:8792/__set?site=shop&v=0' (one site to a version)
 *
 * The sites (their URLs are what a watch is created with; all content is invented):
 *   https://shop.example.com/kettle     an HTML product page with JSON-LD (price, stock) and relative times
 *   https://news.example.org/feed.xml   an RSS feed that gains an item per version
 *   https://api.example.net/v1/release  a JSON API (`$.release.version`)
 *   https://gbk.example.com/notice      a GBK page that names its charset only in <meta charset>
 *   https://flaky.example.com/status    answers 503 on odd versions
 *   https://blocked.example.com/        a bot challenge page
 */
import { createServer } from 'node:http';
import { FakeSites, page, productPage, rss } from '../fake-sites.ts';

const port = Number(process.argv[2] ?? '8792');
const versions = new Map<string, number>([
  ['shop', 0],
  ['news', 0],
  ['api', 0],
  ['gbk', 0],
  ['flaky', 0],
]);
const v = (site: string) => versions.get(site) ?? 0;

const sites = new FakeSites();
sites.set('https://shop.example.com/kettle', () => {
  const prices = ['299.00', '279.00', '279.00', '249.00'];
  const stock = ['InStock', 'OutOfStock', 'InStock', 'InStock'];
  const n = v('shop') % prices.length;
  return {
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: productPage('Synthetic tea kettle', prices[n] ?? '299.00', stock[n] ?? 'InStock').replace(
      '</main>',
      `<section id="reviews"><h2>Reviews</h2><p>Great kettle (${String(n + 2)} hours ago)</p><p>Boils fast.</p></section><aside id="ads">Ad ${String(Date.now() % 97)}</aside></main>`,
    ),
  };
});
sites.set('https://news.example.org/feed.xml', () => ({
  headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
  body: rss(Array.from({ length: 3 + v('news') }, (_, i) => ({ guid: `urn:synthetic:${String(i)}`, title: `Synthetic headline ${String(i)}`, link: `https://news.example.org/${String(i)}` })).reverse()),
}));
sites.set('https://api.example.net/v1/release', () => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ release: { version: `1.${String(v('api'))}.0`, published: new Date().toISOString() } }),
}));
sites.set('https://gbk.example.com/notice', () => {
  // 公告：营业时间调整 / 公告：营业时间不变, in GBK.
  const tail = v('gbk') % 2 === 0 ? [0xb5, 0xf7, 0xd5, 0xfb] : [0xb2, 0xbb, 0xb1, 0xe4];
  return {
    headers: { 'content-type': 'text/html' },
    body: new Uint8Array([
      ...new TextEncoder().encode('<html><head><meta charset="gbk"><title>notice</title></head><body><main><p>'),
      0xb9, 0xab, 0xb8, 0xe6, 0xa3, 0xba, 0xd3, 0xaa, 0xd2, 0xb5, 0xca, 0xb1, 0xbc, 0xe4, ...tail,
      ...new TextEncoder().encode('</p><p>Synthetic notice board for the GBK test page.</p></main></body></html>'),
    ]),
  };
});
sites.set('https://flaky.example.com/status', () =>
  v('flaky') % 2 === 1 ? { status: 503, body: 'down for maintenance' } : { headers: { 'content-type': 'text/html' }, body: page('Status', '<p>All synthetic systems operational.</p>') },
);
sites.set('https://blocked.example.com/', { status: 403, headers: { 'content-type': 'text/html' }, body: '<html><head><title>Just a moment...</title></head><body><div id="cf-chl-widget"></div></body></html>' });

const server = createServer((incoming, outgoing) => {
  const url = new URL(incoming.url ?? '/', `http://127.0.0.1:${String(port)}`);
  if (incoming.method === 'POST' && url.pathname === '/__next') {
    for (const [site, version] of versions) versions.set(site, version + 1);
    outgoing.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Object.fromEntries(versions)));
    return;
  }
  if (incoming.method === 'POST' && url.pathname === '/__set') {
    versions.set(url.searchParams.get('site') ?? '', Number(url.searchParams.get('v') ?? '0'));
    outgoing.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Object.fromEntries(versions)));
    return;
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) if (typeof value === 'string') headers.set(name, value);
  const original = headers.get('x-watch-original-url');
  if (original === null) {
    outgoing.writeHead(400).end('missing x-watch-original-url\n');
    return;
  }
  void sites.handle(new Request(original, { method: incoming.method ?? 'GET', headers })).then(async (response) => {
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    outgoing.writeHead(response.status, responseHeaders).end(new Uint8Array(await response.arrayBuffer()));
    // The request's original URL is synthetic; printing it is what this dev server is for.
    console.log(`${String(response.status)} ${original}`);
  });
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Synthetic sites on http://127.0.0.1:${String(port)} (DEV_FAKE_UPSTREAM)`);
});
