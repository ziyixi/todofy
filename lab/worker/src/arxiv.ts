/**
 * arXiv identifiers, links and the two bounded parsers (docs/design.md §4): the RSS feed
 * (rss.arxiv.org, daily announcements) and the Atom answer of export.arxiv.org/api/query (seeds).
 * Workers have no DOM: both are plain string scans with hard bounds. Everything from the feed is
 * untrusted text: it is stored and shown as plain text, links are rebuilt from the validated ID only.
 */

/** New-style (2609.35773) or old-style (hep-th/9901001) arXiv ID, without version. */
const NEW_ID = /^[0-9]{4}\.[0-9]{4,5}$/;
const OLD_ID = /^[a-z][a-z-]{0,19}(\.[A-Z]{2})?\/[0-9]{7}$/;

export function isArxivId(id: string): boolean {
  return NEW_ID.test(id) || OLD_ID.test(id);
}

/** `arxiv:<id>`, the paper key everywhere in Lab. */
export function paperKey(id: string): string {
  return `arxiv:${id}`;
}

/** The bare ID of a paper key, or null when the key is not a valid `arxiv:<id>`. */
export function bareId(key: string): string | null {
  if (!key.startsWith('arxiv:')) return null;
  const id = key.slice(6);
  return isArxivId(id) ? id : null;
}

export function absUrl(id: string): string {
  return `https://arxiv.org/abs/${id}`;
}

export function pdfUrl(id: string): string {
  return `https://arxiv.org/pdf/${id}`;
}

/**
 * The arXiv ID in something the owner pasted: a bare ID (with or without version), `arXiv:<id>`, or an
 * arxiv.org abs/pdf URL. Returns the ID without version, or null.
 */
export function parseSeedInput(input: string): string | null {
  let text = input.trim();
  if (text.length === 0 || text.length > 200) return null;
  const url = /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?(?:[?#].*)?$/i.exec(text);
  if (url?.[1] !== undefined) text = url[1];
  text = text.replace(/^arxiv:/i, '');
  const match = /^(.+?)(?:v[0-9]{1,3})?$/.exec(text);
  const id = match?.[1] ?? '';
  return isArxivId(id) ? id : null;
}

// ---- text ---------------------------------------------------------------------------------------------

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** XML text content: CDATA unwrapped, entities decoded, control characters removed. */
export function xmlText(raw: string): string {
  const cdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  const decoded = cdata.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/g, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return safeCodePoint(parseInt(name.slice(2), 16), whole);
    if (name.startsWith('#')) return safeCodePoint(parseInt(name.slice(1), 10), whole);
    return ENTITIES[name] ?? whole;
  });
  // eslint-disable-next-line no-control-regex
  return decoded.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function safeCodePoint(code: number, fallback: string): string {
  if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return fallback;
  return String.fromCodePoint(code);
}

/** Whitespace collapsed to single spaces and trimmed. */
export function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The code points of `text` (a surrogate pair stays one character). */
export function codePoints(text: string): string[] {
  return Array.from(text);
}

/** At most `max` code points, with "…" when cut. */
export function clip(text: string, max: number): string {
  const points = codePoints(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`;
}

// ---- RSS ----------------------------------------------------------------------------------------------

export type AnnounceType = 'new' | 'cross' | 'replace' | 'replace-cross';

export interface FeedItem {
  /** Bare arXiv ID without version. */
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly authors: string;
  readonly categories: readonly string[];
  readonly primary_category: string;
  readonly announce_type: AnnounceType;
  readonly abstract: string;
  readonly license: string | null;
}

export interface ParsedFeed {
  /** The announce day from the channel pubDate (its own calendar day), or null when absent. */
  readonly day: string | null;
  /** Items in feed order, the first occurrence of each ID. */
  readonly items: readonly FeedItem[];
  /** Items skipped because a field was missing or invalid. */
  readonly malformed: number;
  /** Items beyond MAX_ITEMS (not parsed). */
  readonly truncated: number;
}

export const MAX_ITEMS = 2000;
export const TITLE_MAX = 1000;
export const AUTHORS_MAX = 1000;
export const ABSTRACT_MAX = 4000;
const CATEGORY_RE = /^[a-z][a-z-]{0,19}(\.[A-Za-z-]{1,20})?$/;
const MONTHS: Readonly<Record<string, string>> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** `Wed, 30 Sep 2026 00:00:00 -0400` → `2026-09-30` (the date as written, i.e. arXiv's own calendar day). */
export function rfc822Day(value: string): string | null {
  const match = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/.exec(value);
  if (!match) return null;
  const month = MONTHS[(match[2] ?? '').toLowerCase()];
  if (month === undefined) return null;
  const day = `${match[3] ?? ''}-${month}-${(match[1] ?? '').padStart(2, '0')}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

/** The text of the first `<tag>` element inside `block`, or null. */
function element(block: string, tag: string): string | null {
  const open = block.indexOf(`<${tag}`);
  if (open < 0) return null;
  const gt = block.indexOf('>', open);
  if (gt < 0) return null;
  if (block[gt - 1] === '/') return '';
  const close = block.indexOf(`</${tag}>`, gt);
  if (close < 0) return null;
  return block.slice(gt + 1, close);
}

function elements(block: string, tag: string, limit: number): string[] {
  const out: string[] = [];
  let from = 0;
  while (out.length < limit) {
    const open = block.indexOf(`<${tag}>`, from);
    if (open < 0) break;
    const close = block.indexOf(`</${tag}>`, open);
    if (close < 0) break;
    out.push(block.slice(open + tag.length + 2, close));
    from = close + tag.length + 3;
  }
  return out;
}

function parseItem(block: string): FeedItem | null {
  const description = xmlText(element(block, 'description') ?? '');
  const head = /arXiv:(\S+?)v(\d{1,3})\s+Announce Type:\s*([a-z-]+)/.exec(description);
  if (!head) return null;
  const id = head[1] ?? '';
  const version = Number(head[2]);
  const typeText = xmlText(element(block, 'arxiv:announce_type') ?? head[3] ?? '').trim();
  if (!isArxivId(id) || !Number.isInteger(version) || version < 1) return null;
  if (typeText !== 'new' && typeText !== 'cross' && typeText !== 'replace' && typeText !== 'replace-cross') return null;
  const abstractAt = description.indexOf('Abstract:');
  const abstract = clip(oneLine(abstractAt >= 0 ? description.slice(abstractAt + 9) : ''), ABSTRACT_MAX);
  const title = clip(oneLine(xmlText(element(block, 'title') ?? '')), TITLE_MAX);
  const categories = [...new Set(elements(block, 'category', 20).map((raw) => xmlText(raw).trim()))].filter((c) => CATEGORY_RE.test(c));
  const primary = categories[0];
  if (title === '' || abstract === '' || primary === undefined) return null;
  const rights = oneLine(xmlText(element(block, 'dc:rights') ?? ''));
  return {
    id,
    version,
    title,
    authors: clip(oneLine(xmlText(element(block, 'dc:creator') ?? '')), AUTHORS_MAX),
    categories: categories.slice(0, 10),
    primary_category: primary,
    announce_type: typeText,
    abstract,
    license: rights === '' ? null : clip(rights, 200),
  };
}

/** Parses the RSS feed text, at most MAX_ITEMS items. Never throws. */
export function parseFeed(xml: string): ParsedFeed {
  const firstItem = xml.indexOf('<item>');
  const channelHead = firstItem < 0 ? xml.slice(0, 20_000) : xml.slice(0, firstItem);
  const pubDate = element(channelHead, 'pubDate');
  const day = pubDate === null ? null : rfc822Day(xmlText(pubDate));
  const items: FeedItem[] = [];
  const seen = new Set<string>();
  let malformed = 0;
  let truncated = 0;
  let from = firstItem < 0 ? xml.length : firstItem;
  let count = 0;
  for (;;) {
    const open = xml.indexOf('<item>', from);
    if (open < 0) break;
    const close = xml.indexOf('</item>', open);
    if (close < 0) break;
    from = close + 7;
    count++;
    if (count > MAX_ITEMS) {
      truncated++;
      continue;
    }
    const item = close - open > 200_000 ? null : parseItem(xml.slice(open + 6, close));
    if (item === null) {
      malformed++;
      continue;
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  return { day, items, malformed, truncated };
}

// ---- Atom (export.arxiv.org/api/query, seeds) --------------------------------------------------------

export interface AtomEntry {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly authors: string;
  readonly categories: readonly string[];
  readonly primary_category: string;
  readonly abstract: string;
  /** `YYYY-MM-DD` of `<published>`. */
  readonly published: string;
}

/** The entries of an arXiv API answer (at most `limit`); error entries and malformed ones are skipped. */
export function parseAtom(xml: string, limit = 50): AtomEntry[] {
  const out: AtomEntry[] = [];
  let from = 0;
  while (out.length < limit) {
    const open = xml.indexOf('<entry>', from);
    if (open < 0) break;
    const close = xml.indexOf('</entry>', open);
    if (close < 0) break;
    from = close + 8;
    const block = xml.slice(open + 7, close);
    const idText = xmlText(element(block, 'id') ?? '').trim();
    const match = /^https?:\/\/arxiv\.org\/abs\/(.+?)v(\d{1,3})$/.exec(idText);
    if (!match || !isArxivId(match[1] ?? '')) continue;
    const published = /^(\d{4}-\d{2}-\d{2})T/.exec(xmlText(element(block, 'published') ?? '').trim())?.[1];
    const title = clip(oneLine(xmlText(element(block, 'title') ?? '')), TITLE_MAX);
    const abstract = clip(oneLine(xmlText(element(block, 'summary') ?? '')), ABSTRACT_MAX);
    const names = elements(block, 'name', 200).map((name) => oneLine(xmlText(name))).filter((name) => name !== '');
    const categories = [...block.matchAll(/<category[^>]*\bterm="([^"]{1,40})"/g)].map((m) => m[1] ?? '').filter((c) => CATEGORY_RE.test(c));
    const primary = /<arxiv:primary_category[^>]*\bterm="([^"]{1,40})"/.exec(block)?.[1] ?? categories[0];
    if (published === undefined || title === '' || abstract === '' || primary === undefined || !CATEGORY_RE.test(primary)) continue;
    out.push({
      id: match[1] ?? '',
      version: Number(match[2]),
      title,
      authors: clip(names.join(', '), AUTHORS_MAX),
      categories: [...new Set([primary, ...categories])].slice(0, 10),
      primary_category: primary,
      abstract,
      published,
    });
  }
  return out;
}
