import { describe, expect, it } from 'vitest';
import { absUrl, bareId, clip, isArxivId, parseAtom, parseFeed, parseSeedInput, paperKey, pdfUrl, rfc822Day, xmlText } from '../src/arxiv.ts';
import { apiUrl, feedUrl, fetchArxiv, FEED_MAX_BYTES, USER_AGENT } from '../src/fetch-arxiv.ts';
import { atomFeed, rssFeed } from './feeds.ts';

describe('arXiv IDs and links', () => {
  it('accepts new- and old-style IDs only', () => {
    for (const id of ['2609.35773', '2609.0001', 'hep-th/9901001', 'math.AG/0601001']) expect(isArxivId(id), id).toBe(true);
    for (const id of ['2609.357', '2609.35773v1', 'arxiv:2609.35773', '../etc/passwd', 'cs/123', '2609.35773?x=1', '']) expect(isArxivId(id), id).toBe(false);
  });

  it('builds keys and links from the validated ID only', () => {
    expect(paperKey('2609.35773')).toBe('arxiv:2609.35773');
    expect(bareId('arxiv:2609.35773')).toBe('2609.35773');
    expect(bareId('arxiv:javascript:alert(1)')).toBeNull();
    expect(bareId('2609.35773')).toBeNull();
    expect(absUrl('2609.35773')).toBe('https://arxiv.org/abs/2609.35773');
    expect(pdfUrl('2609.35773')).toBe('https://arxiv.org/pdf/2609.35773');
  });

  it('reads the ID out of what the owner pastes', () => {
    expect(parseSeedInput('2609.35773')).toBe('2609.35773');
    expect(parseSeedInput(' 2609.35773v3 ')).toBe('2609.35773');
    expect(parseSeedInput('arXiv:2609.35773')).toBe('2609.35773');
    expect(parseSeedInput('https://arxiv.org/abs/2609.35773v2')).toBe('2609.35773');
    expect(parseSeedInput('https://arxiv.org/pdf/2609.35773.pdf')).toBe('2609.35773');
    expect(parseSeedInput('http://export.arxiv.org/abs/hep-th/9901001')).toBe('hep-th/9901001');
    expect(parseSeedInput('https://evil.example.com/abs/2609.35773')).toBeNull();
    expect(parseSeedInput('hello')).toBeNull();
  });

  it('decodes XML text and clips by code points', () => {
    expect(xmlText('a &amp; b &lt;c&gt; &#20013;&#x6587; <![CDATA[<raw>]]>')).toBe('a & b <c> 中文 <raw>');
    expect(xmlText('bad &#0; &#xD800; ok')).toBe('bad &#0; &#xD800; ok');
    expect(clip('一二三四五', 3)).toBe('一二…');
    expect(clip('😀😀😀', 3)).toBe('😀😀😀');
  });

  it('reads the announce day as arXiv writes it', () => {
    expect(rfc822Day('Wed, 30 Sep 2026 00:00:00 -0400')).toBe('2026-09-30');
    expect(rfc822Day('Mon, 5 Oct 2026 00:00:00 -0400')).toBe('2026-10-05');
    expect(rfc822Day('yesterday')).toBeNull();
  });
});

describe('parseFeed', () => {
  it('keeps the first occurrence of each ID, every announce type, and skips malformed items', () => {
    const xml = rssFeed(
      [
        { id: '2609.00001', title: 'Dense retrieval & friends', categories: ['cs.IR', 'cs.CL'] },
        { id: '2609.00002', type: 'cross', title: '大模型检索：一个中文标题', categories: ['cs.CL'] },
        { id: '2609.00001', type: 'cross' },
        { id: '2608.99999', type: 'replace', version: 3 },
        { id: '2608.88888', type: 'replace-cross', version: 2 },
      ],
      undefined,
      `<item><title>No description</title></item>
       <item><description>arXiv:2609.00009v1 Announce Type: new
Abstract: text</description><title>No category</title></item>`,
    );
    const feed = parseFeed(xml);
    expect(feed.day).toBe('2026-09-30');
    expect(feed.malformed).toBe(2);
    expect(feed.items.map((i) => [i.id, i.announce_type, i.version])).toEqual([
      ['2609.00001', 'new', 1],
      ['2609.00002', 'cross', 1],
      ['2608.99999', 'replace', 3],
      ['2608.88888', 'replace-cross', 2],
    ]);
    const first = feed.items[0];
    expect(first?.title).toBe('Dense retrieval & friends');
    expect(first?.categories).toEqual(['cs.IR', 'cs.CL']);
    expect(first?.primary_category).toBe('cs.IR');
    expect(first?.authors).toBe('Ada Example, Bo Sample');
    expect(first?.abstract).toMatch(/^We study synthetic retrieval/);
    expect(first?.license).toBe('http://creativecommons.org/licenses/by/4.0/');
    expect(feed.items[1]?.title).toBe('大模型检索：一个中文标题');
  });

  it('never trusts markup inside the text', () => {
    const feed = parseFeed(rssFeed([{ id: '2609.00003', title: '<script>alert(1)</script> Title', abstract: 'A <b>bold</b> claim.' }]));
    expect(feed.items[0]?.title).toBe('<script>alert(1)</script> Title');
    expect(feed.items[0]?.abstract).toBe('A <b>bold</b> claim.');
  });

  it('bounds the work', () => {
    expect(parseFeed('').items).toEqual([]);
    expect(parseFeed('<rss><channel><item>').day).toBeNull();
    const many = rssFeed(Array.from({ length: 2005 }, (_, i) => ({ id: `2609.${String(10000 + i)}` })));
    const feed = parseFeed(many);
    expect(feed.items).toHaveLength(2000);
    expect(feed.truncated).toBe(5);
  });
});

describe('parseAtom', () => {
  it('reads entries and skips error entries', () => {
    const xml = atomFeed([{ id: '2601.00042', title: 'A seed paper', abstract: 'About retrieval.' }]).replace(
      '</feed>',
      '<entry><id>http://arxiv.org/api/errors#incorrect_id_format_for_1234</id><title>Error</title><summary>incorrect id</summary></entry></feed>',
    );
    const entries = parseAtom(xml);
    expect(entries).toEqual([
      {
        id: '2601.00042',
        version: 2,
        title: 'A seed paper',
        authors: 'Chen Example, Dana Sample',
        categories: ['cs.IR', 'cs.LG'],
        primary_category: 'cs.IR',
        abstract: 'About retrieval.',
        published: '2026-08-01',
      },
    ]);
  });
});

describe('fetchArxiv', () => {
  const ok = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });

  it('sends one GET with the User-Agent, the validators and no redirect following', async () => {
    let seen: Request | undefined;
    const fetcher = ((input: RequestInfo, init?: RequestInit) => {
      seen = new Request(input, init);
      return Promise.resolve(ok('<rss/>', { etag: '"e1"', 'last-modified': 'Wed, 30 Sep 2026 04:00:00 GMT' }));
    }) as typeof fetch;
    const result = await fetchArxiv(feedUrl(['cs.IR', 'cs.CL']), FEED_MAX_BYTES, { etag: '"e0"', lastModified: 'x' }, fetcher);
    expect(result).toEqual({ kind: 'ok', text: '<rss/>', etag: '"e1"', lastModified: 'Wed, 30 Sep 2026 04:00:00 GMT' });
    expect(seen?.url).toBe('https://rss.arxiv.org/rss/cs.IR+cs.CL');
    expect(seen?.headers.get('user-agent')).toBe(USER_AGENT);
    expect(seen?.headers.get('if-none-match')).toBe('"e0"');
    expect(seen?.redirect).toBe('manual');
  });

  it('maps 304, redirects, errors and oversize bodies to codes', async () => {
    const answer = (response: Response) => (() => Promise.resolve(response)) as unknown as typeof fetch;
    expect(await fetchArxiv(feedUrl(['cs.IR']), 100, null, answer(new Response(null, { status: 304 })))).toEqual({ kind: 'not_modified' });
    expect(await fetchArxiv(feedUrl(['cs.IR']), 100, null, answer(new Response(null, { status: 301, headers: { location: 'https://x' } })))).toEqual({ kind: 'error', code: 'redirected' });
    expect(await fetchArxiv(feedUrl(['cs.IR']), 100, null, answer(new Response('x', { status: 503 })))).toEqual({ kind: 'error', code: 'http_503' });
    expect(await fetchArxiv(feedUrl(['cs.IR']), 100, null, answer(ok('x'.repeat(101))))).toEqual({ kind: 'error', code: 'too_large' });
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(64));
      },
    });
    expect(await fetchArxiv(feedUrl(['cs.IR']), 1000, null, answer(new Response(stream)))).toEqual({ kind: 'error', code: 'too_large' });
    const broken = (() => Promise.reject(new Error('boom'))) as unknown as typeof fetch;
    expect(await fetchArxiv(feedUrl(['cs.IR']), 100, null, broken)).toEqual({ kind: 'error', code: 'network_error' });
  });

  it('only ever talks to the two arXiv hosts', async () => {
    const never = (() => {
      throw new Error('fetched');
    }) as unknown as typeof fetch;
    expect(await fetchArxiv('https://example.com/rss', 100, null, never)).toEqual({ kind: 'error', code: 'host_not_allowed' });
    expect(() => feedUrl(['../x', 'javascript:'])).toThrow('no_categories');
    expect(feedUrl(['cs.IR', 'bad cat', 'cs.LG'])).toBe('https://rss.arxiv.org/rss/cs.IR+cs.LG');
    expect(apiUrl(['2601.00042', 'hep-th/9901001'])).toBe('https://export.arxiv.org/api/query?id_list=2601.00042,hep-th/9901001&max_results=2');
  });
});
