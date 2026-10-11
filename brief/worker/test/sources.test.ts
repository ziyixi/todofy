/**
 * Keys, mentions and the parsers on synthetic feeds (no real article): RSS 2, Atom, RDF, the arXiv API, Crossref,
 * Hugging Face, sitemaps and GeoJSON; Atom served as HTML; a truncated body; robots.txt for the brief's own token.
 */
import { describe, expect, it } from 'vitest';
import { ingest } from '../src/collect.ts';
import { arxivIdOfUrl, doiOfUrl, findMentions, parseCrossref, parseGeoJson, parseJsonFeed, parseSitemap, parseXmlFeed, type FeedEntry } from '../src/fetch/feeds.ts';
import { checkFetchUrl, ownSuffixes } from '../src/fetch/policy.ts';
import { parseRobots, robotsAllows, robotsFromAnswer } from '../src/fetch/robots.ts';
import { StepBudget } from '../src/budget.ts';
import { Hosts } from '../src/fetch/hosts.ts';
import { pollSource, pollUrl } from '../src/fetch/poll.ts';
import { cutDocument } from '../src/fetch/page.ts';
import { xmlPlainText, xmlText } from '../src/fetch/text.ts';
import { canonicalKey, normalizeUrl, shortHash } from '../src/keys.ts';
import { DAY } from '../src/limits.ts';
import { bundled, loadRegistry } from '../src/registry.ts';
import { Store, type SourceRow } from '../src/store.ts';
import { memorySql } from './fakes/sql.ts';

describe('canonical keys', () => {
  it('prefer the arXiv ID, then the DOI, then the normalized URL', () => {
    expect(canonicalKey({ arxiv: '2410.01234', doi: '10.1/x', link: 'https://arxiv.org/abs/2410.01234v2' })).toBe('arxiv:2410.01234');
    expect(canonicalKey({ arxiv: null, doi: '10.1029/2026GL000001', link: 'https://x.org' })).toBe('doi:10.1029/2026gl000001');
    expect(canonicalKey({ arxiv: null, doi: null, link: 'HTTP://News.Example.org/a/b/?utm_source=rss&id=3&fbclid=z#top' })).toBe('url:https://news.example.org/a/b?id=3');
    expect(normalizeUrl('https://www.nature.com/articles/s41586-026-0001-1?error=cookies_not_supported')).toBe('https://www.nature.com/articles/s41586-026-0001-1');
    expect(normalizeUrl('https://site.org/')).toBe('https://site.org/');
    expect(normalizeUrl('ftp://site.org/x')).toBeNull();
    expect(shortHash('https://www.anthropic.com/research/x')).toMatch(/^[0-9a-f]{13}$/);
  });

  it('read arXiv IDs and DOIs from links and text (mentions)', () => {
    expect(arxivIdOfUrl('http://arxiv.org/abs/2410.01234v3')).toBe('2410.01234');
    expect(arxivIdOfUrl('https://arxiv.org/pdf/2410.01234v1.pdf')).toBe('2410.01234');
    expect(arxivIdOfUrl('https://arxiv.org/abs/hep-th/9901001v1')).toBe('hep-th/9901001');
    expect(doiOfUrl('https://agupubs.onlinelibrary.wiley.com/doi/10.1029/2026GL000123?af=R')).toBe('10.1029/2026gl000123');
    expect(doiOfUrl('https://doi.org/10.26443/seismica.v5i1.1234')).toBe('10.26443/seismica.v5i1.1234');
    const mentions = findMentions('<a href="https://arxiv.org/abs/2410.01234v2">paper</a> and arXiv:2409.99999, see https://doi.org/10.1038/s41561-026-0001-2.');
    expect(mentions).toEqual(expect.arrayContaining(['arxiv:2410.01234', 'arxiv:2409.99999', 'doi:10.1038/s41561-026-0001-2']));
  });
});

const RSS = `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
<item><title>Synthetic &amp; slow slip</title><link>https://journal.example.org/doi/10.1029/2026GL000123?af=R</link>
<guid>g1</guid><pubDate>Fri, 09 Oct 2026 12:00:00 GMT</pubDate>
<description><![CDATA[<p>First paragraph about <b>slip</b>.</p><p>Second &lt;i&gt;one&lt;/i&gt;.</p>]]></description></item>
<item><title>Second</title><link>https://journal.example.org/a2</link><content:encoded><![CDATA[Full text with a link <a href="https://arxiv.org/abs/2410.00001">here</a>.]]></content:encoded></item>
</channel></rss>`;

describe('the feed parsers', () => {
  it('reads RSS 2 with its DOI, its paragraphs and its mentions', () => {
    const parsed = parseXmlFeed(RSS);
    expect(parsed?.entries).toHaveLength(2);
    const [first, second] = parsed?.entries ?? [];
    expect(first).toMatchObject({ title: 'Synthetic & slow slip', doi: '10.1029/2026gl000123', published: Date.parse('2026-10-09T12:00:00Z') });
    expect(first?.summary).toBe('First paragraph about slip.\n\nSecond one.');
    expect(second?.mentions).toEqual(['arxiv:2410.00001']);
  });

  it('reads Atom served as text/html, by its content', () => {
    const atom = `<html-ish?><feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">Seismic &lt;em&gt;noise&lt;/em&gt;</title>
      <link rel="alternate" href="https://seismica.example.org/article/view/1"/><id>urn:1</id><updated>2026-10-08T00:00:00Z</updated>
      <summary>An abstract.</summary></entry></feed>`;
    const parsed = parseXmlFeed(atom.replace('<html-ish?>', ''));
    expect(parsed?.entries[0]).toMatchObject({ title: 'Seismic noise', link: 'https://seismica.example.org/article/view/1', summary: 'An abstract.' });
  });

  it('reads RDF items by rdf:about and dc:identifier', () => {
    const rdf = `<rdf:RDF xmlns:rdf="x"><item rdf:about="https://www.nature.com/articles/s41561-026-0001-2"><title>Mantle</title>
      <dc:identifier>doi:10.1038/s41561-026-0001-2</dc:identifier><dc:date>2026-10-07</dc:date><description>Abstract text.</description></item></rdf:RDF>`;
    expect(parseXmlFeed(rdf)?.entries[0]).toMatchObject({ link: 'https://www.nature.com/articles/s41561-026-0001-2', doi: '10.1038/s41561-026-0001-2' });
  });

  it('reads the arXiv API: IDs without version, abstract links, the total', () => {
    const feed = `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>188</opensearch:totalResults>
      <entry><id>http://arxiv.org/abs/2410.01234v2</id><title>A  synthetic
      model</title><summary>We study.</summary><published>2026-10-08T17:00:00Z</published></entry></feed>`;
    const parsed = parseXmlFeed(feed);
    expect(parsed?.total).toBe(188);
    expect(parsed?.entries[0]).toMatchObject({ arxiv: '2410.01234', link: 'https://arxiv.org/abs/2410.01234', title: 'A synthetic model' });
  });

  it('parses a truncated feed as far as it got', () => {
    const cut = RSS.slice(0, RSS.indexOf('<item><title>Second'));
    expect(parseXmlFeed(`${cut}<item><title>Half`)?.entries).toHaveLength(1);
    expect(parseXmlFeed('<html><body>no feed</body></html>')).toBeNull();
  });

  it('reads Crossref, Hugging Face, a sitemap and GeoJSON', () => {
    const crossref = JSON.stringify({ message: { items: [{ DOI: '10.1785/0220260001', title: ['A <i>catalog</i>'], abstract: '<jats:title>Abstract</jats:title><jats:p>We built a catalog.</jats:p>', created: { 'date-time': '2026-10-08T01:00:00Z' } }] } });
    expect(parseCrossref(crossref).entries[0]).toMatchObject({ doi: '10.1785/0220260001', title: 'A catalog', summary: 'We built a catalog.', link: 'https://doi.org/10.1785/0220260001' });
    const hf = JSON.stringify([{ paper: { id: '2410.01234', title: 'T', summary: 'S', upvotes: 42, publishedAt: '2026-10-08T00:00:00Z' } }, { paper: { id: 'not-an-id', title: 'x' } }]);
    expect(parseJsonFeed(hf).entries).toEqual([expect.objectContaining({ arxiv: '2410.01234', upvotes: 42 })]);
    expect(parseSitemap('<urlset><url><loc>https://www.anthropic.com/research/a</loc><lastmod>2026</lastmod></url><url><loc>https://www.anthropic.com/news/b</loc></url></urlset>')).toEqual(['https://www.anthropic.com/research/a', 'https://www.anthropic.com/news/b']);
    const geo = JSON.stringify({ features: [{ id: 'us7000', properties: { title: 'M 7.1 - 10 km S of Somewhere', mag: 7.1, magType: 'mww', place: '10 km S of Somewhere', time: Date.parse('2026-10-08T03:00:00Z'), url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000', alert: 'orange', tsunami: 1 }, geometry: { coordinates: [1, 2, 35.2] } }] });
    expect(parseGeoJson(geo).entries[0]?.summary).toBe('Magnitude 7.1 mww. Location: 10 km S of Somewhere. Depth: 35.2 km. Origin time: 2026-10-08T03:00:00.000Z. PAGER alert level: orange. Tsunami flag: yes.');
  });

  it('keeps paragraphs in a feed text and drops scripts', () => {
    expect(xmlText('&lt;p&gt;One&lt;/p&gt;&lt;script&gt;x()&lt;/script&gt;&lt;p&gt;Two&lt;/p&gt;')).toBe('One\n\nTwo');
  });

  it('never strips the text after decoding it: a decoded < or > is the text own', () => {
    expect(xmlText('errors &lt; 5% on all tasks while speedups &gt; 2x were seen')).toBe('errors < 5% on all tasks while speedups > 2x were seen');
    expect(xmlText('a &amp;lt;b and c&amp;gt; d')).toBe('a <b and c> d');
    // A feed that escaped its HTML twice still loses its plain tags.
    expect(xmlText('x&amp;lt;sub&amp;gt;2&amp;lt;/sub&amp;gt; and &amp;lt;i&amp;gt;in situ&amp;lt;/i&amp;gt;')).toBe('x2 and in situ');
    // An arXiv abstract and a Crossref abstract are text, CDATA included.
    expect(xmlPlainText('<![CDATA[for n<m we prove k>2 bounds]]>')).toBe('for n<m we prove k>2 bounds');
    const arxiv = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2410.01234v1</id><title>Bounds for n&lt;m</title>
      <summary>For n&lt;m we prove k&gt;2 bounds.</summary></entry></feed>`;
    expect(parseXmlFeed(arxiv)?.entries[0]).toMatchObject({ title: 'Bounds for n<m', summary: 'For n<m we prove k>2 bounds.' });
    const crossref = JSON.stringify({ message: { items: [{ DOI: '10.1785/0220260002', title: ['Errors &lt; 5%'], abstract: '<jats:p>Misfit for n&lt;m and k&gt;2.</jats:p><jats:p>Second.</jats:p>' }] } });
    expect(parseCrossref(crossref).entries[0]).toMatchObject({ title: 'Errors < 5%', summary: 'Misfit for n<m and k>2.\n\nSecond.' });
  });
});

describe('a sitemap poll', () => {
  const registry = loadRegistry(`version: 1
sources:
  - { id: lab-site, name: Synthetic Lab, section: research, kind: sitemap, url: "https://www.synthetic-lab.org/sitemap.xml", path_prefixes: ["/news/"], text: page_full, review: institution, poll_per_day: 4 }`);
  const urls = ['https://www.synthetic-lab.org/news/old', 'https://www.synthetic-lab.org/news/gone', 'https://www.synthetic-lab.org/news/flaky', 'https://www.synthetic-lab.org/news/later'];
  const sitemap = `<urlset>${urls.map((url) => `<url><loc>${url}</loc></url>`).join('')}</urlset>`;

  it('skips a page that is gone, ends the round at one that fails for a moment, and gives up on it after 3 rounds', async () => {
    const source = registry.byId.get('lab-site');
    if (source === undefined) throw new Error('registry');
    const store = new Store(memorySql());
    store.migrate();
    let now = Date.parse('2026-10-12T10:30:00Z');
    const requested: string[] = [];
    const fetchFn = (request: Request): Promise<Response> => {
      requested.push(request.url);
      const path = new URL(request.url).pathname;
      if (path === '/sitemap.xml') return Promise.resolve(new Response(sitemap));
      if (path === '/news/gone') return Promise.resolve(new Response('gone', { status: 404 }));
      if (path === '/news/flaky') return Promise.resolve(new Response('later', { status: 503 }));
      // (Reading a page's title needs HTMLRewriter, the workerd suite's: here the last page is gone as well.)
      if (path === '/news/later') return Promise.resolve(new Response('gone', { status: 410 }));
      return Promise.resolve(new Response('not found', { status: 404 }));
    };
    let row: SourceRow = { id: 'lab-site', state: 'ok', failures: 0, last_error: '', last_attempt_ms: null, last_success_ms: null, last_round: '', etag: null, last_modified: null, seen: shortHash(urls[0] ?? ''), accepts: '[]', last_item_title: '', last_item_ms: null, page: 0, first_ms: null, tries: '{}' };
    const poll = async () => {
      const budget = new StepBudget(40, 4 * 60_000, () => now, false);
      const clock = { now: () => now, sleep: (ms: number) => ((now += ms), Promise.resolve(true)) };
      const outcome = await pollSource(source, row, { hosts: new Hosts(store, budget, clock, fetchFn, []), fetchFn, own: [], budget, now });
      if (outcome.kind !== 'entries') throw new Error(outcome.kind);
      row = { ...row, seen: outcome.seen ?? row.seen, tries: outcome.tries ?? row.tries };
      // The next round: six hours later, the host's backoff over.
      now += 6 * 3_600_000;
      return outcome;
    };
    const first = await poll();
    // The round is over for this source (no second poll in the same round), the gone page skipped for good.
    expect(first.done).toBe(true);
    expect(first.entries).toEqual([]);
    expect(row.seen.split(',')).toContain(shortHash(urls[1] ?? ''));
    expect(JSON.parse(row.tries)).toEqual({ [shortHash(urls[2] ?? '')]: 1 });
    expect(requested.filter((url) => url.endsWith('/news/later'))).toHaveLength(0);
    await poll();
    const third = await poll();
    expect(third.done).toBe(true);
    expect(row.seen.split(',')).toContain(shortHash(urls[2] ?? ''));
    expect(row.tries).toBe('{}');
    // The next round reaches the page after it.
    expect((await poll()).done).toBe(true);
    expect(requested.filter((url) => url.endsWith('/news/later'))).toHaveLength(1);
    expect(row.seen.split(',')).toContain(shortHash(urls[3] ?? ''));
    expect(requested.filter((url) => url.endsWith('/news/flaky'))).toHaveLength(3);
    expect(requested.filter((url) => url.endsWith('/sitemap.xml'))).toHaveLength(4);
  });
});

describe('ingest', () => {
  const { registry } = bundled();
  const NOW_MS = Date.parse('2026-10-12T10:30:00Z');
  const entry = (overrides: Partial<FeedEntry>): FeedEntry => ({ title: 'A synthetic post', link: 'https://synthetic.example.org/p', summary: 'A synthetic summary that is long enough to read.', published: NOW_MS - DAY, guid: 'g', doi: null, arxiv: null, upvotes: null, mentions: [], ...overrides });
  const row = (id: string): SourceRow => ({ id, state: 'ok', failures: 0, last_error: '', last_attempt_ms: null, last_success_ms: null, last_round: '', etag: null, last_modified: null, seen: '', accepts: '[]', last_item_title: '', last_item_ms: null, page: 0, first_ms: null, tries: '{}' });
  const source = (id: string) => {
    const found = registry.byId.get(id);
    if (found === undefined) throw new Error(id);
    return found;
  };

  it('skips an entry dated past its section age, so a feed of old posts adds none and a pruned one never returns', () => {
    const store = new Store(memorySql());
    store.migrate();
    const counts = ingest(store, source('interconnects'), row('interconnects'), [entry({ link: 'https://synthetic.example.org/new' }), entry({ link: 'https://synthetic.example.org/old', published: NOW_MS - 60 * DAY })], NOW_MS, '2026-10-12');
    expect(counts.created).toBe(1);
    const world = ingest(store, source('bbc-world'), row('bbc-world'), [entry({ link: 'https://synthetic.example.org/w1', published: NOW_MS - 2 * DAY }), entry({ link: 'https://synthetic.example.org/w2', published: NOW_MS - 10 * DAY })], NOW_MS, '2026-10-12');
    expect(world.created).toBe(1);
    // An entry without a date is taken.
    expect(ingest(store, source('interconnects'), row('interconnects'), [entry({ link: 'https://synthetic.example.org/undated', published: null })], NOW_MS, '2026-10-12').created).toBe(1);
  });

  it('records a mention made before its paper was fetched when the paper comes', () => {
    const store = new Store(memorySql());
    store.migrate();
    ingest(store, source('import-ai'), row('import-ai'), [entry({ link: 'https://synthetic.example.org/issue-1', mentions: ['arxiv:2410.12345'] })], NOW_MS, '2026-10-12');
    expect(store.count(`SELECT count(*) AS n FROM pending_mentions`)).toBe(1);
    ingest(store, source('arxiv-llm-agents'), row('arxiv-llm-agents'), [entry({ title: 'A synthetic paper', link: 'https://arxiv.org/abs/2410.12345', arxiv: '2410.12345' })], NOW_MS + 3_600_000, '2026-10-12');
    const paper = store.one<{ mentions: string }>(`SELECT mentions FROM items WHERE key = 'arxiv:2410.12345'`);
    expect(JSON.parse(paper?.mentions ?? '[]')).toEqual([expect.objectContaining({ s: 'import-ai' })]);
    expect(store.count(`SELECT count(*) AS n FROM pending_mentions`)).toBe(0);
  });
});

describe('the fetch policy and poll URLs', () => {
  it('refuses http, IP literals, local suffixes and the owner own names', () => {
    const own = ownSuffixes('brief.ziyixi.science');
    expect(checkFetchUrl('https://export.arxiv.org/api/query?x=1#f', own)?.href).toBe('https://export.arxiv.org/api/query?x=1');
    expect(checkFetchUrl('http://export.arxiv.org/', own)).toBeNull();
    expect(checkFetchUrl('https://10.0.0.1/', own)).toBeNull();
    expect(checkFetchUrl('https://printer.local/', own)).toBeNull();
    expect(checkFetchUrl('https://sort.ziyixi.science/', own)).toBeNull();
    expect(checkFetchUrl('https://x.workers.dev/', own)).toBeNull();
    expect(checkFetchUrl('https://user:pw@site.org/', own)).toBeNull();
    expect(checkFetchUrl('https://site.org:8443/', own)).toBeNull();
  });

  it('fills arXiv window and page, and Crossref date', () => {
    const registry = loadRegistry(`version: 1
sources:
  - { id: q, name: arXiv, section: research, kind: arxiv_api, url: "https://export.arxiv.org/api/query?search_query={q}&start={start}&max_results=100", query: "cat:physics.geo-ph", text: page_full, review: preprint }
  - { id: c, name: GJI, section: research, kind: crossref, url: "https://api.crossref.org/journals/x/works?filter=from-created-date:{date}", date_offset_days: 3, text: feed_abstract, review: peer_reviewed }`);
    const now = Date.parse('2026-10-12T10:30:00Z');
    const q = registry.byId.get('q');
    const c = registry.byId.get('c');
    if (q === undefined || c === undefined) throw new Error('registry');
    const arxiv = pollUrl(q, 2, now);
    expect(decodeURIComponent(arxiv)).toContain('(cat:physics.geo-ph) AND submittedDate:[202610051030 TO 202610121030]');
    expect(arxiv).toContain('start=200');
    expect(pollUrl(c, 0, now)).toContain('from-created-date:2026-10-09');
  });
});

describe('robots.txt for the brief', () => {
  it('honours only a group naming ziyixi-brief, and the Crawl-delay', () => {
    const text = 'User-agent: *\nDisallow: /\nCrawl-delay: 10\n\nUser-agent: Claude-User\nUser-agent: ChatGPT-User\nDisallow: /\n';
    const verdict = parseRobots(text);
    expect(robotsAllows(verdict, '/news/article-1')).toBe(true);
    expect(verdict.crawlDelayMs).toBe(10_000);
    const ours = parseRobots('User-agent: ziyixi-brief\nDisallow: /private/\nAllow: /private/open\nCrawl-delay: 2\n');
    expect(robotsAllows(ours, '/private/x')).toBe(false);
    expect(robotsAllows(ours, '/private/open/y')).toBe(true);
    expect(ours.crawlDelayMs).toBe(2000);
    expect(robotsFromAnswer(404, null).disallowAll).toBe(false);
    expect(robotsFromAnswer(503, null).disallowAll).toBe(true);
    expect(robotsFromAnswer(0, null).disallowAll).toBe(true);
  });
});

describe('the document cut', () => {
  it('keeps the start and, when a heading names it, the conclusion', () => {
    const body = Array.from({ length: 60 }, (_, i) => `Paragraph ${String(i)} ${'x'.repeat(380)}`).join('\n\n');
    const text = `Abstract. We did things.\n\n${body}\n\n## 6 Conclusions\n\nThe conclusion is clear.`;
    const cut = cutDocument(text, 4000);
    expect(cut.length).toBeLessThanOrEqual(4000);
    expect(cut.startsWith('Abstract. We did things.')).toBe(true);
    expect(cut).toContain('[…]');
    expect(cut.endsWith('The conclusion is clear.')).toBe(true);
    expect(cutDocument('short', 4000)).toBe('short');
  });
});
