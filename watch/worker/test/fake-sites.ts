/**
 * Synthetic websites for the tests and for local development (../../docs/design.md §10): every page the Worker fetches
 * in a test comes from here, never from the internet. The workerd suite plugs `FakeSites.handle` into Miniflare's
 * outbound service (no socket at all); `serve.ts` serves the same sites on a loopback port for `wrangler dev` with
 * DEV_FAKE_UPSTREAM, where the original URL travels in the `x-watch-original-url` header.
 *
 * A site is a route per URL (scheme, host, path and query): a fixed answer or a function of the request and how many
 * times the URL was asked. /robots.txt answers 404 (everything allowed) unless a test sets it. Every request is
 * recorded with its headers, so tests can check the etiquette (User-Agent, Accept, Accept-Language, validators,
 * spacing). Hosts are under example.com, example.org and example.net (reserved names) and their content is invented.
 */

export interface FakeAnswer {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
  /** Wait this long before answering (timeouts). */
  readonly delayMs?: number;
}

export type FakeRoute = FakeAnswer | ((request: Request, count: number) => FakeAnswer | Promise<FakeAnswer>);

export interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** The URL a request is for: the original one in dev (x-watch-original-url), else its own. */
export function originalUrl(request: Request): string {
  return request.headers.get('x-watch-original-url') ?? request.url;
}

export class FakeSites {
  readonly routes = new Map<string, FakeRoute>();
  readonly requests: Recorded[] = [];
  private readonly counts = new Map<string, number>();

  /** Sets the answer of `url`. */
  set(url: string, route: FakeRoute): this {
    this.routes.set(new URL(url).href, route);
    return this;
  }

  /** An HTML page. */
  html(url: string, body: string, headers: Record<string, string> = {}): this {
    return this.set(url, { headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body });
  }

  /** The robots.txt of `origin` (`https://host`). */
  robots(origin: string, route: FakeRoute): this {
    return this.set(`${origin}/robots.txt`, route);
  }

  /** Requests made to `url` (or to every URL starting with it when `prefix`). */
  requestsTo(url: string, prefix = false): Recorded[] {
    const href = new URL(url).href;
    return this.requests.filter((request) => (prefix ? request.url.startsWith(href) : request.url === href));
  }

  /** Forgets the recorded requests (the routes stay). */
  clearRequests(): void {
    this.requests.length = 0;
  }

  reset(): void {
    this.routes.clear();
    this.clearRequests();
    this.counts.clear();
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(originalUrl(request));
    const headers: Record<string, string> = {};
    request.headers.forEach((value, name) => {
      if (name !== 'x-watch-original-url') headers[name] = value;
    });
    this.requests.push({ url: url.href, method: request.method, headers });
    const count = (this.counts.get(url.href) ?? 0) + 1;
    this.counts.set(url.href, count);
    const route = this.routes.get(url.href);
    if (route === undefined) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    const answer = typeof route === 'function' ? await route(request, count) : route;
    if (answer.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, answer.delayMs));
    const status = answer.status ?? 200;
    const body = status === 304 || status === 204 ? null : (answer.body ?? '');
    return new Response(body, { status, headers: answer.headers ?? {} });
  }
}

/** A page with a body of `content` and the usual chrome around it (nav, header, footer, a script). */
export function page(title: string, content: string, extra = ''): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title><script>var t = Date.now();</script><style>body{color:red}</style></head>
<body><header><a href="/">Example Shop</a></header><nav><ul><li><a href="/a">Menu A</a></li><li><a href="/b">Menu B</a></li></ul></nav>
<main id="content">${content}</main>${extra}<footer>© 2026 Example Shop. All rights reserved.</footer></body></html>`;
}

/** An RSS 2.0 feed of `items`. */
export function rss(items: readonly { readonly guid: string; readonly title: string; readonly link: string; readonly description?: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Example feed</title><link>https://news.example.org/</link>${items
    .map((item) => `<item><guid>${item.guid}</guid><title>${item.title}</title><link>${item.link}</link><description><![CDATA[${item.description ?? ''}]]></description></item>`)
    .join('')}</channel></rss>`;
}

/** An Atom feed of `entries`. */
export function atom(entries: readonly { readonly id: string; readonly title: string; readonly link: string }[]): string {
  return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Example</title>${entries
    .map((entry) => `<entry><id>${entry.id}</id><title type="text">${entry.title}</title><link rel="alternate" href="${entry.link}"/><updated>2026-10-01T00:00:00Z</updated></entry>`)
    .join('')}</feed>`;
}

/** A product page with schema.org JSON-LD. */
export function productPage(name: string, price: string, availability: string): string {
  const ld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'Product', name, sku: 'SKU-1', offers: { '@type': 'Offer', price, priceCurrency: 'CNY', availability: `https://schema.org/${availability}` } });
  return page(name, `<h1>${name}</h1><p>价格 ¥${price}</p>`, `<script type="application/ld+json">${ld}</script>`);
}
