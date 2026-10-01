/**
 * Stage 2 for FeedSource (../../../docs/design.md §5): RSS 2.0 / 1.0, Atom 1.0 and JSON Feed 1.x, read with bounded
 * string scans (Workers have no DOM; HTMLRewriter would read RSS's `<link>text</link>` as a void element). Everything
 * from a feed is untrusted text: it becomes lines and keys, nothing else.
 *
 * An item's key is its guid (RSS), id (Atom, JSON Feed) or else its link, so NewItemTrigger sees an item once even
 * when its title is edited. Its line is `title — link` (and ` — summary` with include_summaries, tags stripped).
 */
import { ITEMS_MAX, LINE_MAX } from '../limits.ts';
import { decodeEntities } from './entities.ts';

export interface FeedItem {
  readonly key: string;
  readonly text: string;
}

export type FeedResult = { readonly ok: true; readonly items: FeedItem[] } | { readonly ok: false };

const SUMMARY_MAX = 300;

/** XML text: CDATA unwrapped, references decoded, tags of escaped HTML removed, whitespace collapsed. */
export function xmlText(raw: string): string {
  const unwrapped = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Decoded once for the XML escaping; an escaped HTML summary (`&lt;p&gt;`) then becomes tags, which are dropped.
  const decoded = decodeEntities(unwrapped.replace(/<[^>]*>/g, ' '));
  return decodeEntities(decoded.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** The first `<name ...>...</name>` inside `block` (namespace prefixes allowed), as raw text, or null. */
function element(block: string, names: readonly string[]): string | null {
  for (const name of names) {
    const match = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${name}\\s*>`, 'i').exec(block);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/** The href of an Atom `<link>` (rel alternate or none), or null. */
function atomLink(block: string): string | null {
  for (const tag of block.matchAll(/<(?:[A-Za-z0-9_-]+:)?link\b([^>]*)\/?>/gi)) {
    const attributes = tag[1] ?? '';
    const rel = /\brel\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1];
    const href = /\bhref\s*=\s*["']([^"']*)["']/i.exec(attributes)?.[1];
    if (href !== undefined && (rel === undefined || rel === 'alternate')) return decodeEntities(href.trim());
  }
  return null;
}

function line(title: string, link: string, summary: string | null): string {
  const parts = [title === '' ? '(无标题)' : title];
  if (link !== '') parts.push(link);
  if (summary !== null && summary !== '') parts.push(summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX)}…` : summary);
  const text = parts.join(' — ');
  return text.length > LINE_MAX ? text.slice(0, LINE_MAX) : text;
}

/** An XML feed's items (RSS `<item>`, Atom `<entry>`), or null when the text is no feed. */
function xmlFeed(text: string, includeSummaries: boolean): FeedItem[] | null {
  if (!/<(?:[A-Za-z0-9_-]+:)?(?:rss|RDF|feed)\b/i.test(text.slice(0, 4096))) return null;
  const items: FeedItem[] = [];
  for (const match of text.matchAll(/<(?:[A-Za-z0-9_-]+:)?(item|entry)\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?\1\s*>/gi)) {
    if (items.length >= ITEMS_MAX) break;
    const block = match[2] ?? '';
    const title = xmlText(element(block, ['title']) ?? '');
    const rssLink = element(block, ['link']);
    const link = rssLink !== null && rssLink.trim() !== '' ? xmlText(rssLink) : (atomLink(block) ?? '');
    const id = xmlText(element(block, ['guid', 'id']) ?? '');
    const summary = includeSummaries ? xmlText(element(block, ['description', 'summary', 'content']) ?? '') : null;
    const key = id !== '' ? id : link !== '' ? link : title;
    if (key === '') continue;
    items.push({ key: key.slice(0, LINE_MAX), text: line(title, link, summary) });
  }
  return items;
}

/** A JSON Feed's items, or null when the text is no JSON Feed. */
function jsonFeed(text: string, includeSummaries: boolean): FeedItem[] | null {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof document !== 'object' || document === null) return null;
  const { version, items } = document as { version?: unknown; items?: unknown };
  if (typeof version !== 'string' || !version.startsWith('https://jsonfeed.org/version/1') || !Array.isArray(items)) return null;
  const out: FeedItem[] = [];
  for (const item of items.slice(0, ITEMS_MAX) as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    const text = (name: string) => (typeof record[name] === 'string' ? record[name].replace(/\s+/g, ' ').trim() : '');
    const link = text('url');
    const id = text('id');
    const key = id !== '' ? id : link !== '' ? link : text('title');
    if (key === '') continue;
    const summary = includeSummaries ? text('summary') || text('content_text') : null;
    out.push({ key: key.slice(0, LINE_MAX), text: line(text('title'), link, summary) });
  }
  return out;
}

/** The items of a feed body, or `ok: false` when it is neither an XML feed nor a JSON Feed. */
export function parseFeed(text: string, includeSummaries: boolean): FeedResult {
  const trimmed = text.trimStart();
  const items = trimmed.startsWith('{') ? jsonFeed(trimmed, includeSummaries) : xmlFeed(trimmed, includeSummaries);
  return items === null ? { ok: false } : { ok: true, items };
}
