/**
 * One poll of a registry source (../../../docs/design.md §3.2): its URL with the placeholders filled, a conditional GET
 * for the feeds that answer one, the body read up to its `max_bytes` and parsed as far as it got, by its content.
 *
 * - arXiv: each query is limited to the submissions of the last ARXIV_WINDOW_DAYS (`submittedDate:[…]`, added here)
 *   and read in full, newest first, in pages of ARXIV_PAGE (at most ARXIV_PAGES): a page per poll, the next page in
 *   the next poll of the same round, so a round that runs out of subrequests resumes where it stopped. One request
 *   every 3 s on one connection across all queries is the host pacing of export.arxiv.org (hosts.ts).
 * - Crossref and Hugging Face: `{date}` is the UTC date `date_offset_days` before the poll.
 * - A sitemap (Anthropic has no feed): the first poll only records every URL; a later poll turns a few new URLs under
 *   the source's path prefixes into items, each page read (through its robots.txt) for a title and a summary. Its
 *   `lastmod` is rewritten in bulk, so it is never read as a date. A page that is gone or refuses (a 4xx, a refused
 *   redirect) is skipped for good; one that fails for a moment (429, a 5xx, a timeout) ends the source's round and is
 *   tried again in the next rounds, SITEMAP_URL_TRIES in all, so a failing page never makes the round poll again.
 *
 * A host that is not ready, or a step out of subrequests or time, defers the source (`deferred`), never a failure.
 * 429 and 503 back the host off and defer too. Anything else that is not a 2xx or 304, a timeout, a parse error or a
 * body too large is a failure with a code.
 */
import type { StepBudget } from '../budget.ts';
import { ARXIV_PAGE, ARXIV_PAGES, ARXIV_WINDOW_DAYS, DAY, PAGE_MAX_BYTES, SITEMAP_URL_TRIES } from '../limits.ts';
import type { Source } from '../registry.ts';
import { shortHash } from '../keys.ts';
import { parseJson, type SourceRow } from '../store.ts';
import { parseCrossref, parseGeoJson, parseJsonFeed, parseSitemap, parseXmlFeed, ParseError, type FeedEntry, type ParsedFeed } from './feeds.ts';
import type { Hosts } from './hosts.ts';
import { httpGet, type FetchFn, type GetAnswer } from './net.ts';
import { pageMeta } from './meta.ts';
import { checkFetchUrl } from './policy.ts';
import { decodeBody, detectCharset } from './text.ts';

export interface PollEnv {
  readonly hosts: Hosts;
  readonly fetchFn: FetchFn;
  readonly own: readonly string[];
  readonly budget: StepBudget;
  readonly now: number;
}

export type PollOutcome =
  | {
      readonly kind: 'entries';
      readonly entries: FeedEntry[];
      /** The source is done for this round (false: an arXiv page or a sitemap URL is left). */
      readonly done: boolean;
      readonly nextPage: number;
      readonly etag: string | null;
      readonly lastModified: string | null;
      /** A sitemap's seen URL hashes, when they changed. */
      readonly seen: string | null;
      /** A sitemap's failing URL hashes and their tries (JSON), when they changed. */
      readonly tries: string | null;
    }
  | { readonly kind: 'not_modified' }
  | { readonly kind: 'failed'; readonly code: string }
  | { readonly kind: 'deferred'; readonly until: number | null };

/** New sitemap URLs read per poll. */
const SITEMAP_NEW_MAX = 3;
const SEEN_MAX = 6000;
const FEED_ACCEPT = 'application/rss+xml, application/atom+xml, application/rdf+xml, application/xml;q=0.9, text/xml;q=0.9, application/json;q=0.8, */*;q=0.5';

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function arxivStamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace(/[-T:]/g, '');
}

/** The URL of a poll: `{q}` (arXiv's query with its window), `{start}` and `{date}` filled. */
export function pollUrl(source: Source, page: number, now: number): string {
  let url = source.url;
  if (source.query !== null) {
    const query = `(${source.query}) AND submittedDate:[${arxivStamp(now - ARXIV_WINDOW_DAYS * DAY)} TO ${arxivStamp(now)}]`;
    url = url.replace('{q}', encodeURIComponent(query));
  }
  return url.replace('{start}', String(page * ARXIV_PAGE)).replace('{date}', utcDate(now - source.dateOffsetDays * DAY));
}

function failure(answer: GetAnswer): PollOutcome {
  if (answer.kind === 'refused') return { kind: 'deferred', until: answer.refusal.kind === 'host' ? answer.refusal.until : null };
  if (answer.kind === 'failed') return answer.failure === 'aborted' ? { kind: 'deferred', until: null } : { kind: 'failed', code: answer.failure };
  if (answer.status === 429 || answer.status === 503) return { kind: 'deferred', until: null };
  return { kind: 'failed', code: `http_${String(answer.status)}` };
}

function parse(source: Source, text: string): ParsedFeed {
  switch (source.kind) {
    case 'crossref':
      return parseCrossref(text);
    case 'json':
      return parseJsonFeed(text);
    case 'geojson':
      return parseGeoJson(text);
    default: {
      const parsed = parseXmlFeed(text);
      if (parsed === null) throw new ParseError();
      return parsed;
    }
  }
}

async function sitemapPoll(source: Source, row: SourceRow, env: PollEnv, body: string): Promise<PollOutcome> {
  const urls = parseSitemap(body);
  const seen = new Set(row.seen === '' ? [] : row.seen.split(','));
  const fresh = urls.filter((url) => !seen.has(shortHash(url)));
  if (row.seen === '') {
    // The first poll records what exists; nothing becomes an item.
    const hashes = urls.map(shortHash).slice(-SEEN_MAX);
    return { kind: 'entries', entries: [], done: true, nextPage: 0, etag: null, lastModified: null, seen: hashes.join(','), tries: null };
  }
  const tries = new Map(Object.entries(parseJson<Record<string, number>>(row.tries, {})));
  const entries: FeedEntry[] = [];
  const newSeen = [...seen];
  const skip = (hash: string): void => {
    newSeen.push(hash);
    tries.delete(hash);
  };
  let done = true;
  let read = 0;
  for (const url of fresh) {
    const hash = shortHash(url);
    let path = '';
    try {
      path = new URL(url).pathname;
    } catch {
      skip(hash);
      continue;
    }
    if (!source.pathPrefixes.some((prefix) => path.startsWith(prefix) && path.length > prefix.length)) {
      skip(hash);
      continue;
    }
    if (read >= SITEMAP_NEW_MAX || env.budget.spent()) {
      done = false;
      break;
    }
    const target = checkFetchUrl(url, env.own);
    if (target === null) {
      skip(hash);
      continue;
    }
    read += 1;
    const answer = await httpGet(env.fetchFn, { url: target, accept: 'text/html, */*;q=0.5', own: env.own, gate: env.hosts.pageGate(), signal: env.budget.signal, maxBytes: PAGE_MAX_BYTES, truncate: true });
    if (answer.kind === 'refused' && answer.refusal.kind === 'robots') {
      skip(hash);
      continue;
    }
    if (answer.kind === 'refused' || (answer.kind === 'failed' && answer.failure === 'aborted')) {
      // The host is not ready, or the step is out of requests or time: the rest waits for the next poll.
      done = false;
      break;
    }
    if (answer.kind === 'answer' && answer.status === 200) {
      const meta = await pageMeta(answer.body, answer.headers.get('content-type'));
      skip(hash);
      if (meta.title !== '') entries.push({ title: meta.title, link: answer.finalUrl, summary: meta.description, published: null, guid: url, doi: null, arxiv: null, upvotes: null, mentions: meta.mentions });
      continue;
    }
    const moment = answer.kind === 'failed' ? answer.failure === 'timeout' || answer.failure === 'network_error' : answer.status === 429 || answer.status >= 500;
    if (!moment) {
      // Gone or refused (a 4xx, a refused redirect): skipped for good.
      skip(hash);
      continue;
    }
    // A failure of the moment ends the source's round (`done` stays true): the page waits for the next round.
    const tried = (tries.get(hash) ?? 0) + 1;
    if (tried >= SITEMAP_URL_TRIES) skip(hash);
    else tries.set(hash, tried);
    break;
  }
  // Only the URLs the sitemap still lists keep their tries.
  const listed = new Set(fresh.map(shortHash));
  const kept = Object.fromEntries([...tries].filter(([hash]) => listed.has(hash)));
  return { kind: 'entries', entries, done, nextPage: 0, etag: null, lastModified: null, seen: newSeen.slice(-SEEN_MAX).join(','), tries: JSON.stringify(kept) };
}

/** One poll of `source` (its next arXiv page). */
export async function pollSource(source: Source, row: SourceRow, env: PollEnv): Promise<PollOutcome> {
  const page = source.kind === 'arxiv_api' ? Math.max(0, Math.min(ARXIV_PAGES - 1, row.page)) : 0;
  const url = checkFetchUrl(pollUrl(source, page, env.now), env.own);
  if (url === null) return { kind: 'failed', code: 'url_refused' };
  const conditional = ['rss', 'atom', 'rdf'].includes(source.kind) ? { etag: row.etag, lastModified: row.last_modified } : null;
  const answer = await httpGet(env.fetchFn, {
    url,
    accept: FEED_ACCEPT,
    own: env.own,
    gate: env.hosts.feedGate(),
    signal: env.budget.signal,
    conditional,
    maxBytes: source.maxBytes,
    truncate: true,
  });
  if (answer.kind !== 'answer') return failure(answer);
  if (answer.status === 304) return { kind: 'not_modified' };
  if (answer.status < 200 || answer.status >= 300) return failure(answer);
  const text = decodeBody(answer.body, detectCharset(answer.headers.get('content-type'), answer.body));
  try {
    if (source.kind === 'sitemap') return await sitemapPoll(source, row, env, text);
    const parsed = parse(source, text);
    let done = true;
    let nextPage = 0;
    if (source.kind === 'arxiv_api') {
      const read = (page + 1) * ARXIV_PAGE;
      const more = parsed.entries.length >= ARXIV_PAGE && page + 1 < ARXIV_PAGES && (parsed.total === null || read < parsed.total);
      done = !more;
      nextPage = more ? page + 1 : 0;
    }
    return {
      kind: 'entries',
      entries: parsed.entries,
      done,
      nextPage,
      etag: conditional === null ? null : answer.headers.get('etag'),
      lastModified: conditional === null ? null : answer.headers.get('last-modified'),
      seen: null,
      tries: null,
    };
  } catch (error) {
    if (error instanceof ParseError) return { kind: 'failed', code: 'parse_error' };
    throw error;
  }
}
