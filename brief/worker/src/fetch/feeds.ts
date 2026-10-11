/**
 * The parsers of the registry's kinds (../../../docs/design.md §3.2): RSS 2.0, Atom, RSS 1.0 (RDF), the arXiv API's
 * Atom, Crossref's works, Hugging Face's daily papers (JSON), sitemaps and USGS GeoJSON. The format is read from the
 * content, not the header (Seismica serves Atom as text/html), and a body read only up to its `max_bytes` is parsed as
 * far as it got: XML items are scanned with bounded regular expressions (Workers have no DOM), so a cut last item is
 * simply not there. Everything from a feed is untrusted text: it becomes items, nothing else.
 */
import { xmlPlainText, xmlText, oneLine, decodeEntities } from './text.ts';

export interface FeedEntry {
  readonly title: string;
  readonly link: string;
  /** The feed's text of the item: its full text for a feed_full source, else its abstract or summary. */
  readonly summary: string;
  readonly published: number | null;
  readonly guid: string;
  readonly doi: string | null;
  /** The arXiv ID without its version. */
  readonly arxiv: string | null;
  /** Hugging Face's upvotes. */
  readonly upvotes: number | null;
  /** The canonical keys of the arXiv IDs and DOIs the item's text and links name (mentions, design §4). */
  readonly mentions: readonly string[];
}

export interface ParsedFeed {
  readonly entries: FeedEntry[];
  /** arXiv: the window's total (opensearch:totalResults). */
  readonly total: number | null;
}

export class ParseError extends Error {
  constructor() {
    super('parse_error');
    this.name = 'ParseError';
  }
}

const NEW_ARXIV = /\b(\d{4}\.\d{4,5})(v\d+)?\b/;
const OLD_ARXIV = /\b([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?\b/;
const DOI = /\b(10\.\d{4,9}\/[^\s"'<>]+)/;

/** A DOI without trailing punctuation, lower-cased. */
export function cleanDoi(doi: string): string {
  return decodeEntities(doi).replace(/[).,;:\]}>]+$/, '').toLowerCase();
}

/** The arXiv ID (without version) an arXiv URL names, or null. */
export function arxivIdOfUrl(url: string): string | null {
  const match = /arxiv\.org\/(?:abs|pdf|html)\/([^?#\s]+?)(?:v\d+)?(?:\.pdf)?(?:[?#]|$)/i.exec(url);
  if (match?.[1] === undefined) return null;
  const id = match[1];
  return NEW_ARXIV.test(id) || OLD_ARXIV.test(id) ? id.replace(/v\d+$/, '') : null;
}

/** The DOI a URL names (doi.org, or a publisher's /doi/ path), or null. */
export function doiOfUrl(url: string): string | null {
  const match = /(?:doi\.org\/|\/doi\/(?:abs\/|full\/|pdf\/|epdf\/)?)(10\.\d{4,9}\/[^?#\s]+)/i.exec(url);
  return match?.[1] === undefined ? null : cleanDoi(decodeURIComponent(match[1]));
}

/** The canonical keys of every arXiv ID and DOI in `raw` (an item's HTML or text): its links and its words. */
export function findMentions(raw: string): string[] {
  const found = new Set<string>();
  for (const match of raw.matchAll(/arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})/gi)) if (match[1] !== undefined) found.add(`arxiv:${match[1]}`);
  for (const match of raw.matchAll(/\barXiv:\s?(\d{4}\.\d{4,5})/gi)) if (match[1] !== undefined) found.add(`arxiv:${match[1]}`);
  for (const match of raw.matchAll(/arxiv\.org\/abs\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7})/gi)) if (match[1] !== undefined) found.add(`arxiv:${match[1]}`);
  for (const match of raw.matchAll(/\b(10\.\d{4,9}\/[^\s"'<>&]+)/g)) if (match[1] !== undefined) found.add(`doi:${cleanDoi(match[1])}`);
  return [...found].slice(0, 50);
}

function date(text: string | null): number | null {
  if (text === null || text.trim() === '') return null;
  const ms = Date.parse(text.trim());
  return Number.isFinite(ms) ? ms : null;
}

/** The first `<name ...>...</name>` inside `block` (a namespace prefix allowed), as raw text, or null. */
function element(block: string, names: readonly string[]): string | null {
  for (const name of names) {
    const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}\\s*>`, 'i').exec(block);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

function atomLink(block: string): string | null {
  let fallback: string | null = null;
  for (const tag of block.matchAll(/<(?:atom:)?link\b([^>]*)\/?>/gi)) {
    const attributes = tag[1] ?? '';
    const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1];
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1];
    if (href === undefined) continue;
    if (rel === undefined || rel === 'alternate') return decodeEntities(href.trim());
    fallback ??= decodeEntities(href.trim());
  }
  return fallback;
}

/** An XML feed's (RSS, Atom, RDF, arXiv) items in document order, or null when the text is no XML feed. */
export function parseXmlFeed(text: string): ParsedFeed | null {
  const head = text.slice(0, 4096);
  if (!/<(?:[A-Za-z0-9_-]+:)?(?:rss|RDF|feed)\b/.test(head)) return null;
  const entries: FeedEntry[] = [];
  for (const match of text.matchAll(/<(item|entry)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi)) {
    const attributes = match[2] ?? '';
    const block = match[3] ?? '';
    const rssLink = element(block, ['link']);
    const about = /\brdf:about\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    let link = rssLink !== null && rssLink.trim() !== '' ? oneLine(xmlText(rssLink)) : (atomLink(block) ?? (about === undefined ? '' : decodeEntities(about)));
    const guid = oneLine(xmlText(element(block, ['guid', 'id']) ?? ''));
    let arxiv = arxivIdOfUrl(guid) ?? arxivIdOfUrl(link);
    if (arxiv !== null && /arxiv\.org/i.test(guid + link)) link = `https://arxiv.org/abs/${arxiv}`;
    else arxiv = null;
    // An arXiv paper's title and abstract are text, never HTML: `n < m` stays.
    const text = arxiv === null ? xmlText : xmlPlainText;
    const title = oneLine(text(element(block, ['title']) ?? ''));
    const rawBody = element(block, ['content:encoded', 'content', 'description', 'summary', 'dc:description']) ?? '';
    const summary = text(rawBody);
    const published = date(element(block, ['pubDate', 'dc:date', 'published', 'prism:publicationDate', 'updated']));
    const identifier = element(block, ['prism:doi', 'arxiv:doi', 'dc:identifier']);
    let doi = identifier === null ? null : (DOI.exec(decodeEntities(identifier))?.[1] ?? null);
    doi = doi === null ? doiOfUrl(link) : cleanDoi(doi);
    if (title === '' && link === '') continue;
    entries.push({ title, link, summary, published, guid, doi, arxiv, upvotes: null, mentions: findMentions(rawBody) });
  }
  const total = Number(/<opensearch:totalResults[^>]*>\s*(\d+)\s*</i.exec(head + text.slice(4096, 8192))?.[1] ?? NaN);
  return { entries, total: Number.isFinite(total) ? total : null };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Crossref's works (`message.items`): DOI, title, abstract (JATS, tags dropped), created, URL. */
export function parseCrossref(text: string): ParsedFeed {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new ParseError();
  }
  const items = record(record(document)?.['message'])?.['items'];
  if (!Array.isArray(items)) throw new ParseError();
  const entries: FeedEntry[] = [];
  for (const raw of items as unknown[]) {
    const item = record(raw);
    if (item === null) continue;
    const doi = cleanDoi(str(item['DOI']));
    const titles = item['title'];
    const title = oneLine(xmlPlainText(Array.isArray(titles) ? str(titles[0]) : str(titles)));
    if (doi === '' || title === '') continue;
    const created = record(item['created']);
    const rawAbstract = str(item['abstract']);
    entries.push({
      title,
      link: `https://doi.org/${doi}`,
      summary: xmlPlainText(rawAbstract.replace(/<jats:title>[\s\S]*?<\/jats:title>/gi, ' ')),
      published: date(str(created?.['date-time'])),
      guid: doi,
      doi,
      arxiv: null,
      upvotes: null,
      mentions: findMentions(rawAbstract),
    });
  }
  return { entries, total: null };
}

/** Hugging Face's daily papers (an array of {paper: {id, title, summary, upvotes, publishedAt}}), or Algolia's hits. */
export function parseJsonFeed(text: string): ParsedFeed {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new ParseError();
  }
  const entries: FeedEntry[] = [];
  const hits = record(document)?.['hits'];
  if (Array.isArray(hits)) {
    for (const raw of hits as unknown[]) {
      const hit = record(raw);
      const url = str(hit?.['url']);
      const title = oneLine(str(hit?.['title']));
      if (url === '' || title === '') continue;
      entries.push({ title, link: url, summary: '', published: date(str(hit?.['created_at'])), guid: url, doi: doiOfUrl(url), arxiv: arxivIdOfUrl(url), upvotes: null, mentions: findMentions(url) });
    }
    return { entries, total: null };
  }
  if (!Array.isArray(document)) throw new ParseError();
  for (const raw of document as unknown[]) {
    const outer = record(raw);
    const paper = record(outer?.['paper']) ?? outer;
    if (paper === null) continue;
    const id = str(paper['id']);
    const arxiv = NEW_ARXIV.test(id) || OLD_ARXIV.test(id) ? id.replace(/v\d+$/, '') : null;
    const title = oneLine(str(paper['title']) || str(outer?.['title']));
    if (arxiv === null || title === '') continue;
    const upvotes = typeof paper['upvotes'] === 'number' && Number.isFinite(paper['upvotes']) ? Math.max(0, Math.round(paper['upvotes'])) : null;
    entries.push({
      title,
      link: `https://arxiv.org/abs/${arxiv}`,
      summary: oneLine(str(paper['summary'])),
      published: date(str(paper['publishedAt']) || str(outer?.['publishedAt'])),
      guid: arxiv,
      doi: null,
      arxiv,
      upvotes,
      mentions: [],
    });
  }
  return { entries, total: null };
}

/** USGS GeoJSON: each feature's title, and a text built from its properties (magnitude, place, depth, time, alert). */
export function parseGeoJson(text: string): ParsedFeed {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new ParseError();
  }
  const features = record(document)?.['features'];
  if (!Array.isArray(features)) throw new ParseError();
  const entries: FeedEntry[] = [];
  for (const raw of features as unknown[]) {
    const feature = record(raw);
    const p = record(feature?.['properties']);
    if (p === null) continue;
    const url = str(p['url']);
    const title = oneLine(str(p['title']));
    if (url === '' || title === '') continue;
    const time = typeof p['time'] === 'number' ? p['time'] : null;
    const coordinates = record(feature?.['geometry'])?.['coordinates'];
    const depth = Array.isArray(coordinates) && typeof coordinates[2] === 'number' ? coordinates[2] : null;
    const facts = [
      typeof p['mag'] === 'number' ? `Magnitude ${String(p['mag'])} ${str(p['magType'])}`.trim() : '',
      str(p['place']) === '' ? '' : `Location: ${str(p['place'])}`,
      depth === null ? '' : `Depth: ${String(Math.round(depth * 10) / 10)} km`,
      time === null ? '' : `Origin time: ${new Date(time).toISOString()}`,
      str(p['alert']) === '' ? '' : `PAGER alert level: ${str(p['alert'])}`,
      p['tsunami'] === 1 ? 'Tsunami flag: yes' : '',
      typeof p['felt'] === 'number' ? `Felt reports: ${String(p['felt'])}` : '',
    ].filter((fact) => fact !== '');
    entries.push({ title, link: url, summary: facts.join('. ') + '.', published: time, guid: str(feature?.['id']) || url, doi: null, arxiv: null, upvotes: null, mentions: [] });
  }
  return { entries, total: null };
}

/** A sitemap's page URLs (`<url><loc>`), in document order. */
export function parseSitemap(text: string): string[] {
  if (!/<urlset\b/i.test(text.slice(0, 4096))) throw new ParseError();
  const urls: string[] = [];
  for (const match of text.matchAll(/<url\b[^>]*>[\s\S]*?<loc>\s*([^<\s]+)\s*<\/loc>/gi)) if (match[1] !== undefined) urls.push(decodeEntities(match[1]));
  return urls;
}
