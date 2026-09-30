/**
 * Synthetic arXiv answers built in code (docs/design.md §12): an RSS feed like rss.arxiv.org's and an
 * Atom answer like export.arxiv.org/api/query's. Titles, authors and abstracts are invented.
 */

export interface SyntheticItem {
  readonly id: string;
  readonly version?: number;
  readonly type?: 'new' | 'cross' | 'replace' | 'replace-cross';
  readonly title?: string;
  readonly categories?: readonly string[];
  readonly abstract?: string;
  readonly authors?: string;
}

const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function rssItem(item: SyntheticItem): string {
  const version = item.version ?? 1;
  const type = item.type ?? 'new';
  const categories = item.categories ?? ['cs.IR'];
  return `    <item>
      <title>${escape(item.title ?? `Synthetic paper ${item.id}`)}</title>
      <link>https://arxiv.org/abs/${item.id}</link>
      <description>arXiv:${item.id}v${String(version)} Announce Type: ${type}
Abstract: ${escape(item.abstract ?? `We study synthetic retrieval problem number ${item.id}. Our method improves recall on a toy benchmark.`)}</description>
      <guid isPermaLink="false">oai:arXiv.org:${item.id}v${String(version)}</guid>
${categories.map((c) => `      <category>${c}</category>`).join('\n')}
      <pubDate>Wed, 30 Sep 2026 00:00:00 -0400</pubDate>
      <arxiv:announce_type>${type}</arxiv:announce_type>
      <dc:rights>http://creativecommons.org/licenses/by/4.0/</dc:rights>
      <dc:creator>${escape(item.authors ?? 'Ada Example, Bo Sample')}</dc:creator>
    </item>`;
}

/** A whole feed for announce day `pubDate` (RFC 822, arXiv's own offset). */
export function rssFeed(items: readonly SyntheticItem[], pubDate = 'Wed, 30 Sep 2026 00:00:00 -0400', extra = ''): string {
  return `<?xml version='1.0' encoding='UTF-8'?>
<rss xmlns:arxiv="http://arxiv.org/schemas/atom" xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
  <channel>
    <title>cs.IR, cs.CL, cs.LG updates on arXiv.org</title>
    <link>http://rss.arxiv.org/rss/cs.IR+cs.CL+cs.LG</link>
    <language>en-us</language>
    <pubDate>${pubDate}</pubDate>
${items.map(rssItem).join('\n')}
${extra}
  </channel>
</rss>`;
}

export function atomFeed(entries: readonly { id: string; title: string; abstract: string; published?: string; primary?: string }[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>arXiv Query</title>
${entries
  .map(
    (e) => `  <entry>
    <id>http://arxiv.org/abs/${e.id}v2</id>
    <published>${e.published ?? '2026-08-01T12:00:00Z'}</published>
    <title>${escape(e.title)}</title>
    <summary>${escape(e.abstract)}</summary>
    <author><name>Chen Example</name></author>
    <author><name>Dana Sample</name></author>
    <arxiv:primary_category term="${e.primary ?? 'cs.IR'}" scheme="http://arxiv.org/schemas/atom"/>
    <category term="${e.primary ?? 'cs.IR'}" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  </entry>`,
  )
  .join('\n')}
</feed>`;
}

/** A deterministic unit-ish vector for a text (the fake bge-m3): a few hashed coordinates plus a topic axis. */
export function fakeEmbedding(text: string, dimensions = 1024): number[] {
  const out = new Array<number>(dimensions).fill(0);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
    out[hash % dimensions] = (out[hash % dimensions] ?? 0) + 1;
  }
  // Topic axes: papers about "retrieval" point one way, "vision" another.
  if (/retrieval|recall|search/i.test(text)) out[0] = (out[0] ?? 0) + 40;
  if (/vision|image|pixel/i.test(text)) out[1] = (out[1] ?? 0) + 40;
  return out;
}

/** 40 papers: every third about vision, the rest about retrieval; a few cross-lists and replacements. */
export function dayItems(prefix: string, count = 40): SyntheticItem[] {
  const items: SyntheticItem[] = [];
  for (let i = 0; i < count; i++) {
    const vision = i % 3 === 0;
    items.push({
      id: `${prefix}.${String(10000 + i)}`,
      type: i % 10 === 9 ? 'cross' : 'new',
      title: vision ? `Pixel-level vision model ${String(i)}` : `Dense retrieval study ${String(i)}`,
      abstract: vision ? `We train an image model on pixels, variant ${String(i)}.` : `We improve search recall with retrieval trick ${String(i)}.`,
      categories: [['cs.IR', 'cs.CL', 'cs.LG'][i % 3] ?? 'cs.IR'],
    });
  }
  items.push({ id: '2608.00001', type: 'replace', version: 2 });
  return items;
}
