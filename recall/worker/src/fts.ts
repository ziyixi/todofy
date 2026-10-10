/**
 * The search index's rows (../../docs/design.md §6.1): one FTS5 row per page, rowid = pages.rowid, with the page's
 * title, its URL's words (the host and the path) and the first 32 KiB of its latest captured text, each prepared by
 * the shared segmenter (bigrams for Chinese, Japanese and Korean). Written when a page is first seen (title and URL),
 * replaced at each new latest capture, reduced to title and URL by the index budget (the alarm) and deleted with its
 * page; each rewrite takes the page's current title. A title change alone is not indexed (it would cost a text read and
 * a row rewrite for every unread-count title such as `收件箱 (3)`); the page's stored title still changes.
 */
import { segment } from '../../shared/segment.ts';
import { cutUtf8 } from '../../shared/url.ts';
import { INDEXED_TEXT_MAX_BYTES } from './limits.ts';
import type { Store } from './store.ts';

/** A URL's host and path as words (percent-escapes decoded where they decode), for the index's url column. */
export function urlWords(url: string): string {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // Not decodable as UTF-8: the escaped path still has its ASCII words.
    }
    return `${parsed.hostname} ${path.replaceAll('/', ' ')}`;
  } catch {
    return url;
  }
}

/** The part of a text the index holds: its first INDEXED_TEXT_MAX_BYTES of UTF-8, and that part's size. */
export function indexedPart(text: string): { readonly text: string; readonly bytes: number } {
  const cut = cutUtf8(text, INDEXED_TEXT_MAX_BYTES);
  return { text: cut.text, bytes: new TextEncoder().encode(cut.text).byteLength };
}

/** Writes (or replaces) a page's index row; `body` is the indexed part of its latest text, or '' for none. */
export function writeIndexRow(store: Store, rowid: number, title: string, url: string, body: string, replace: boolean): void {
  if (replace) store.run(`DELETE FROM fts WHERE rowid = ?`, rowid);
  store.run(`INSERT INTO fts (rowid, title, url, body) VALUES (?, ?, ?, ?)`, rowid, segment(title), segment(urlWords(url)), body === '' ? '' : segment(body));
}

export function deleteIndexRow(store: Store, rowid: number): void {
  store.run(`DELETE FROM fts WHERE rowid = ?`, rowid);
}
