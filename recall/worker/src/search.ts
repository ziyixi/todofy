/**
 * SearchPages (../../docs/design.md §6.2, §6.3): the query's terms as FTS5 phrases over the bigram index (fts.ts,
 * shared/segment.ts), narrowed by a time range, a site, a type and a minimum of focus, sorted by relevance or by the
 * latest visit. The server never parses an operator: the UI turns `site:`, `after:` and the others into typed fields.
 *
 * Every row a search reads counts against the account's daily rows read, so a search first gathers its candidate
 * pages from its most selective condition, each source bounded, and then keeps the candidates that meet every other
 * condition:
 *
 * - a time range: the range's visits, newest first, at most SEARCH_MAX_VISITS (a visit overlaps [start, end) when it
 *   starts before `end` and ends after `start`; a visit lasts at most 6 hours, so the scan starts 6 hours before
 *   `start`), grouped by page: their count, focus and latest end within the range;
 * - else a site with at most SITE_MAX_PAGES pages: all of them;
 * - else words: the index's matches, at most SEARCH_MAX_MATCHES (by BM25 for 相关; for 最新 all of them when there
 *   are no more, else the scan below, which finds the newest of a common word's pages at once);
 * - else: the scan of the pages by their latest visit, SCAN_CHUNK at a time, until enough results are found or
 *   SEARCH_SCAN_PAGES pages were read.
 *
 * The words' matches are read once for every source (at most SEARCH_MAX_MATCHES rows): a range's or a site's
 * candidates meet them there, and only past that bound (a common word) is each candidate looked up in the index.
 *
 * A search answers its first SEARCH_MAX_RESULTS results (and one more, to tell whether others follow) at once; api.ts
 * keeps them for the next pages. A bound that can change those results is reported (`capped`), so an answer without
 * it is complete. Snippets come from the R2 text of each result of the page.
 */
import { isLoneCjk, searchable, segment, tokensOf } from '../../shared/segment.ts';
import {
  QUERY_MAX_CHARS,
  QUERY_MAX_TERMS,
  SCAN_CHUNK,
  SEARCH_CACHE_ENTRIES,
  SEARCH_CACHE_MS,
  SEARCH_MAX_MATCHES,
  SEARCH_MAX_RESULTS,
  SEARCH_MAX_VISITS,
  SEARCH_SCAN_PAGES,
  SITE_MAX_PAGES,
  SNIPPET_CHARS,
  VISIT_MAX_MS,
} from './limits.ts';
import { hostKeyRange, type Store } from './store.ts';

/** A query read into terms: `match` is the FTS5 expression (null without a term), `terms` the words to highlight. */
export interface Query {
  readonly match: string | null;
  readonly terms: readonly string[];
}

export class QueryError extends Error {
  readonly reason: 'BAD_REQUEST' | 'QUERY_NOT_SEARCHABLE';

  constructor(reason: 'BAD_REQUEST' | 'QUERY_NOT_SEARCHABLE', message: string) {
    super(message);
    this.reason = reason;
  }
}

/** The terms of a query: spaces separate them, double quotes make a phrase one term (an unclosed one runs to the end). */
export function splitTerms(query: string): string[] {
  const terms: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of query) {
    if (char === '"') {
      if (current.trim() !== '') terms.push(current.trim());
      current = '';
      quoted = !quoted;
    } else if (!quoted && /\s/u.test(char)) {
      if (current !== '') terms.push(current);
      current = '';
    } else current += char;
  }
  if (current.trim() !== '') terms.push(current.trim());
  return terms;
}

/**
 * A term as an FTS5 phrase: segmented (whitespace runs as one space), every `"` doubled. A lone CJK character next to
 * Latin letters or digits in a term (`iOS版`, `2026年`, `新iPhone`) may stand in a longer CJK run in the text
 * (`iOS版本`, `最新iPhone`), which the index holds only as pairs: as the phrase's last token it is a prefix
 * (`"ios 版"*` finds `版本`), and as its first it is left out of the phrase (FTS5 has no suffix query; the UI still
 * marks the whole term).
 */
export function phrase(term: string): string {
  let text = segment(term).trim().replace(/\s+/gu, ' ');
  let tokens = tokensOf(text);
  const first = tokens[0] ?? '';
  if (tokens.length > 1 && isLoneCjk(first)) {
    text = text.slice(text.indexOf(first) + first.length).trim();
    tokens = tokens.slice(1);
  }
  const prefix = tokens.length > 1 && isLoneCjk(tokens[tokens.length - 1] ?? '');
  return `"${text.replaceAll('"', '""')}"${prefix ? '*' : ''}`;
}

/**
 * The query's FTS5 expression: every searchable term as a phrase, joined with spaces (all must match). At most
 * QUERY_MAX_CHARS characters and QUERY_MAX_TERMS terms (BAD_REQUEST); a term that leaves nothing searchable
 * (punctuation only, a lone CJK character) is dropped, and a query left with none is QUERY_NOT_SEARCHABLE.
 */
export function readQuery(query: string): Query {
  if (query.trim() === '') return { match: null, terms: [] };
  if (Array.from(query).length > QUERY_MAX_CHARS) throw new QueryError('BAD_REQUEST', 'the query is longer than 200 characters');
  const terms = splitTerms(query);
  if (terms.length > QUERY_MAX_TERMS) throw new QueryError('BAD_REQUEST', 'the query has more than 10 terms');
  const kept = terms.filter(searchable);
  if (kept.length === 0) throw new QueryError('QUERY_NOT_SEARCHABLE', 'the query has no term the index can find');
  return { match: kept.map(phrase).join(' '), terms: kept };
}

export interface SearchInput {
  readonly query: Query;
  /** The range [start, end): null for no bound. */
  readonly start: number | null;
  readonly end: number | null;
  /** A host (its subdomains included), or null. */
  readonly site: string | null;
  readonly readOnly: boolean;
  readonly minFocusSeconds: number;
  readonly sort: 'relevance' | 'recent';
}

/** A result: a live page, with its visits, focus and latest end within the range (of all time without one). */
export interface ResultRow extends Record<string, SqlStorageValue> {
  rowid: number;
  id: string;
  url: string;
  title: string;
  host_key: string;
  document_count: number;
  latest_document: string | null;
  visit_count: number;
  focus_seconds: number;
  last_ms: number | null;
  /** BM25 of the words (lower is better); null without words. */
  score: number | null;
}

export interface SearchRows {
  /** The first SEARCH_MAX_RESULTS results in order, and one more when others follow. */
  readonly rows: readonly ResultRow[];
  /** A read bound was reached where it can change the results. */
  readonly capped: boolean;
}

/** Results asked of every source: a search's most, and one more. */
const WANTED = SEARCH_MAX_RESULTS + 1;
const PAGE_COLUMNS = `p.rowid AS rowid, p.id AS id, p.url AS url, p.title AS title, p.host_key AS host_key, p.document_count AS document_count,
  p.latest_text_document AS latest_document, p.visit_count AS visit_count, p.focus_seconds AS focus_seconds, p.last_visit_ms AS last_ms`;
const RANK = `rank MATCH 'bm25(5.0, 2.0, 1.0)'`;

/** The conditions on `p` other than the words: the site and the type, and the page's whole focus without a range. */
function pageConditions(input: SearchInput, withFocus: boolean): { sql: string; params: (string | number)[] } {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (input.site !== null) {
    const [low, high] = hostKeyRange(input.site);
    parts.push('p.host_key >= ? AND p.host_key < ?');
    params.push(low, high);
  }
  if (input.readOnly) parts.push('p.document_count > 0');
  if (withFocus && input.minFocusSeconds > 0) {
    parts.push('p.focus_seconds >= ?');
    params.push(input.minFocusSeconds);
  }
  return { sql: parts.length === 0 ? '1' : parts.join(' AND '), params };
}

/** Sorts results by BM25 (then the latest visit) for 相关, or by the latest visit, newest first; the rowid breaks ties. */
function sortResults(rows: ResultRow[], input: SearchInput): ResultRow[] {
  const recency = (a: ResultRow, b: ResultRow) => (b.last_ms ?? -Infinity) - (a.last_ms ?? -Infinity) || b.rowid - a.rowid;
  return rows.sort(input.sort === 'relevance' && input.query.match !== null ? (a, b) => (a.score ?? 0) - (b.score ?? 0) || recency(a, b) : recency);
}

/**
 * The words' matches, read once: at most SEARCH_MAX_MATCHES with their BM25 (the best ones for 相关; for 最新, which
 * needs no score, any), and whether there are more.
 */
interface Matches {
  readonly scores: ReadonlyMap<number, number>;
  readonly more: boolean;
}

function readMatches(store: Store, match: string, relevance: boolean): Matches {
  const rows = store.all<{ rowid: number; score: number }>(
    relevance
      ? `SELECT rowid, rank AS score FROM fts WHERE fts MATCH ? AND ${RANK} ORDER BY rank LIMIT ?`
      : `SELECT rowid, 0 AS score FROM fts WHERE fts MATCH ? ORDER BY rowid DESC LIMIT ?`,
    match,
    SEARCH_MAX_MATCHES + 1,
  );
  return { scores: new Map(rows.slice(0, SEARCH_MAX_MATCHES).map((row) => [row.rowid, row.score])), more: rows.length > SEARCH_MAX_MATCHES };
}

/**
 * The candidates among `rowids` that meet the page conditions and the words: one indexed read per candidate. The words
 * come from their matches when all of them were read; past SEARCH_MAX_MATCHES (a common word) each candidate is looked
 * up in the index instead, for its BM25 (相关) or its presence (最新).
 */
function pagesAmong(store: Store, rowids: readonly number[], input: SearchInput, withFocus: boolean, matches: Matches | null): ResultRow[] {
  const match = input.query.match;
  const probe = match !== null && matches?.more === true;
  const wanted = match === null || probe ? rowids : rowids.filter((rowid) => matches?.scores.has(rowid) === true);
  if (wanted.length === 0) return [];
  const conditions = pageConditions(input, withFocus);
  const relevance = input.sort === 'relevance';
  const score = !probe
    ? 'NULL'
    : relevance
      ? `(SELECT rank FROM fts WHERE fts MATCH ? AND ${RANK} AND fts.rowid = p.rowid)`
      : `(SELECT 0 FROM fts WHERE fts MATCH ? AND fts.rowid = p.rowid)`;
  const rows = store.all<ResultRow>(
    `SELECT ${PAGE_COLUMNS}, ${score} AS score FROM json_each(?) j JOIN pages p ON p.rowid = j.value WHERE ${conditions.sql}`,
    ...(probe ? [match] : []),
    JSON.stringify(wanted),
    ...conditions.params,
  );
  if (probe) return rows.filter((row) => row.score !== null);
  return match === null ? rows : rows.map((row) => ({ ...row, score: matches?.scores.get(row.rowid) ?? null }));
}

/** The range's newest visits grouped by page; the pages that meet every condition, with their focus within the range. */
function byRange(store: Store, input: SearchInput, matches: Matches | null): SearchRows {
  const start = input.start ?? Number.MIN_SAFE_INTEGER;
  const end = input.end ?? Number.MAX_SAFE_INTEGER;
  const visits = store.all<{ page_rowid: number; end_ms: number; focus_seconds: number }>(
    `SELECT page_rowid, end_ms, focus_seconds FROM visits WHERE start_ms >= ? AND start_ms < ? AND end_ms > ? ORDER BY start_ms DESC LIMIT ?`,
    input.start === null ? start : start - VISIT_MAX_MS,
    end,
    start,
    SEARCH_MAX_VISITS + 1,
  );
  const groups = new Map<number, { visits: number; focus: number; last: number }>();
  for (const visit of visits.slice(0, SEARCH_MAX_VISITS)) {
    const group = groups.get(visit.page_rowid) ?? { visits: 0, focus: 0, last: visit.end_ms };
    groups.set(visit.page_rowid, { visits: group.visits + 1, focus: group.focus + visit.focus_seconds, last: Math.max(group.last, visit.end_ms) });
  }
  const focused = [...groups].filter(([, group]) => group.focus >= input.minFocusSeconds).map(([rowid]) => rowid);
  const rows = pagesAmong(store, focused, input, false, matches).map((row) => {
    const group = groups.get(row.rowid);
    return { ...row, visit_count: group?.visits ?? 0, focus_seconds: group?.focus ?? 0, last_ms: group?.last ?? null };
  });
  return { rows: sortResults(rows, input).slice(0, WANTED), capped: visits.length > SEARCH_MAX_VISITS };
}

/** The scan: pages by their latest visit, newest first, a chunk a statement, until WANTED results or the bound. */
function byScan(store: Store, input: SearchInput): SearchRows {
  const conditions = pageConditions(input, true);
  const match = input.query.match;
  const words = match === null ? '1' : `EXISTS (SELECT 1 FROM fts WHERE fts MATCH ? AND fts.rowid = p.rowid)`;
  const found: ResultRow[] = [];
  let after: { readonly ms: number; readonly rowid: number } | null = null;
  for (let scanned = 0; scanned < SEARCH_SCAN_PAGES; ) {
    const keyset = after === null ? '' : 'WHERE (p.last_visit_ms, p.rowid) < (?, ?)';
    const chunk: (ResultRow & { ok: number })[] = store.all<ResultRow & { ok: number }>(
      `SELECT ${PAGE_COLUMNS}, NULL AS score, CASE WHEN ${conditions.sql} THEN ${words} ELSE 0 END AS ok FROM pages p ${keyset}
       ORDER BY p.last_visit_ms DESC, p.rowid DESC LIMIT ?`,
      ...conditions.params,
      ...(match === null ? [] : [match]),
      ...(after === null ? [] : [after.ms, after.rowid]),
      SCAN_CHUNK,
    );
    scanned += chunk.length;
    for (const { ok, ...row } of chunk) if (ok === 1) found.push(row);
    const last = chunk[chunk.length - 1];
    // The pages ran out (a page's latest visit is never null: a page made by a capture has the capture's time).
    if (chunk.length < SCAN_CHUNK || last?.last_ms == null || found.length >= WANTED) return { rows: found.slice(0, WANTED), capped: false };
    after = { ms: last.last_ms, rowid: last.rowid };
  }
  return { rows: found.slice(0, WANTED), capped: true };
}

/** The words' matches as candidates: the best SEARCH_MAX_MATCHES for 相关; for 最新 all of them, or the scan past them. */
function byWords(store: Store, input: SearchInput, matches: Matches): SearchRows {
  if (matches.more && input.sort === 'recent') return byScan(store, input);
  // The candidates are the matches read: their scores are known, nothing is looked up again.
  const rows = pagesAmong(store, [...matches.scores.keys()], input, true, { ...matches, more: false });
  const sorted = sortResults(rows, input).slice(0, WANTED);
  // The best SEARCH_MAX_MATCHES hold the best WANTED results unless the other conditions left fewer.
  return { rows: sorted, capped: matches.more && sorted.length < WANTED };
}

/** The rowids of a site's pages (its subdomains included), or null when it has more than SITE_MAX_PAGES. */
function sitePages(store: Store, site: string): number[] | null {
  const [low, high] = hostKeyRange(site);
  const pages = store.all<{ rowid: number }>(`SELECT rowid FROM pages WHERE host_key >= ? AND host_key < ? LIMIT ?`, low, high, SITE_MAX_PAGES + 1);
  return pages.length > SITE_MAX_PAGES ? null : pages.map((page) => page.rowid);
}

/**
 * Answered searches by their parameters (the page token's), so that 加载更多 reads nothing again: at most
 * SEARCH_CACHE_ENTRIES, each for SEARCH_CACHE_MS, in the object's memory (a restarted object searches again). A
 * search's next pages show the results as its first page found them; a deletion empties the cache.
 */
export class SearchCache {
  private readonly entries = new Map<string, { readonly at: number; readonly found: SearchRows }>();

  get(key: string, now: number): SearchRows | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined || now - entry.at > SEARCH_CACHE_MS) return undefined;
    return entry.found;
  }

  put(key: string, found: SearchRows, now: number): void {
    this.entries.delete(key);
    this.entries.set(key, { at: now, found });
    for (const old of this.entries.keys()) {
      if (this.entries.size <= SEARCH_CACHE_ENTRIES) break;
      this.entries.delete(old);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

/** The search's first SEARCH_MAX_RESULTS results (and one more), from its most selective condition. */
export function search(store: Store, input: SearchInput): SearchRows {
  const matches = input.query.match === null ? null : readMatches(store, input.query.match, input.sort === 'relevance');
  if (input.start !== null || input.end !== null) return byRange(store, input, matches);
  // A site small enough to read whole answers every other condition exactly, words included.
  const site = input.site === null ? null : sitePages(store, input.site);
  if (site !== null) return { rows: sortResults(pagesAmong(store, site, input, true, matches), input).slice(0, WANTED), capped: false };
  if (matches !== null) return byWords(store, input, matches);
  return byScan(store, input);
}

// ---- snippets --------------------------------------------------------------------------------------------------------

export interface Segment {
  readonly text: string;
  readonly highlighted: boolean;
}

/** One character as the search compares it: NFKC (for non-ASCII), lower case. */
function fold(char: string): string {
  return char.charCodeAt(0) < 0x80 ? char.toLowerCase() : char.normalize('NFKC').toLowerCase();
}

/** A text folded character by character, with the original offset of every folded offset (and one past the end). */
function folded(text: string): { readonly text: string; readonly origin: readonly number[] } {
  let out = '';
  const origin: number[] = [];
  let at = 0;
  for (const char of text) {
    const f = fold(char);
    for (let i = 0; i < f.length; i++) origin.push(at);
    out += f;
    at += char.length;
  }
  origin.push(at);
  return { text: out, origin };
}

/** The words a query highlights: each term's words (a phrase's too), folded, longest first. */
export function highlightWords(terms: readonly string[]): string[] {
  const words = new Set<string>();
  for (const term of terms) for (const word of term.normalize('NFKC').toLowerCase().split(/\s+/u)) if (word !== '') words.add(word);
  return [...words].sort((a, b) => b.length - a.length);
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * About SNIPPET_CHARS characters of a text around the first occurrence of any query word (ignoring case and width),
 * cut at word boundaries where there are any, every occurrence in it highlighted, whitespace runs as one space;
 * empty when no word occurs.
 */
export function snippetOf(text: string, terms: readonly string[]): Segment[] {
  const words = highlightWords(terms);
  if (words.length === 0 || text === '') return [];
  const f = folded(text);
  let first = -1;
  for (const word of words) {
    const at = f.text.indexOf(word);
    if (at !== -1 && (first === -1 || at < first)) first = at;
  }
  if (first === -1) return [];
  const center = f.origin[first] ?? 0;
  let start = Math.max(0, center - Math.floor(SNIPPET_CHARS / 3));
  let end = Math.min(text.length, start + SNIPPET_CHARS);
  // Word boundaries: never start or end inside a word when a space is near.
  if (start > 0 && WORD_CHAR.test(text[start - 1] ?? '')) {
    const space = text.slice(start, Math.min(center, start + 20)).search(/\s/u);
    if (space !== -1) start += space + 1;
  }
  if (end < text.length && WORD_CHAR.test(text[end] ?? '')) {
    const tail = text.slice(Math.max(center, end - 20), end);
    const space = tail.search(/\s\S*$/u);
    if (space !== -1) end = Math.max(center, end - 20) + space;
  }
  // Never split a surrogate pair.
  if (start > 0 && /[\udc00-\udfff]/.test(text[start] ?? '')) start += 1;
  if (end < text.length && /[\udc00-\udfff]/.test(text[end] ?? '')) end -= 1;
  // Highlights: every occurrence of a word inside the window, in original offsets, overlaps merged.
  const marks: [number, number][] = [];
  for (const word of words) {
    for (let at = f.text.indexOf(word); at !== -1; at = f.text.indexOf(word, at + 1)) {
      const from = f.origin[at] ?? 0;
      const to = f.origin[at + word.length] ?? text.length;
      if (from >= end) break;
      if (from >= start && to <= end) marks.push([from, to]);
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  const segments: Segment[] = [];
  const push = (part: string, highlighted: boolean) => {
    const clean = part.replace(/\s+/gu, ' ');
    if (clean !== '') segments.push({ text: clean, highlighted });
  };
  let at = start;
  if (start > 0) push('…', false);
  for (const [from, to] of marks) {
    if (from < at) continue;
    push(text.slice(at, from), false);
    push(text.slice(from, to), true);
    at = to;
  }
  push(text.slice(at, end), false);
  if (end < text.length) push('…', false);
  // Adjacent plain parts (the ellipsis and its text) read as one segment.
  return segments.reduce<Segment[]>((out, part) => {
    const last = out[out.length - 1];
    if (last !== undefined && !last.highlighted && !part.highlighted) out[out.length - 1] = { text: last.text + part.text, highlighted: false };
    else out.push(part);
    return out;
  }, []);
}
