/**
 * Full text for the shortlisted documents only (../../docs/design.md §6), by each source's `text` tier:
 *
 * - `feed_full`: the feed's own text (kept with the item, cut to 16,000 characters); `feed_abstract`, `feed_summary`:
 *   the feed's abstract or summary; nothing is fetched;
 * - `page_full`: the page through HTMLRewriter (fetch/page.ts): an arXiv paper's HTML version (`arxiv.org/html/<id>`,
 *   the abstract when there is none), else the item's link; cut to 16,000 characters keeping the conclusion;
 * - `page_abstract`: the page's abstract section.
 *
 * Pages are fetched as the owner's browser would (fetch/robots.ts: only a robots.txt group naming the brief applies;
 * the host's Crawl-delay paces it), never past a paywall or a login: a 401, 402 or 403, or a page whose text is too
 * short to be the article, reads as no full text and the feed's text is used, marked 仅摘要. A page that fails for a
 * moment (a timeout, a 5xx, a 429) is tried PAGE_ATTEMPTS times over later alarms, then the feed's text is used. A host
 * that is not ready waits for a later alarm, up to the caller's `waitUntil`: a host backing off past it (a 429's
 * backoff doubles up to hours) leaves its document with the feed's text, so the issue never waits on one host. Each
 * document's row in `texts` starts with the feed's text as its fallback, so a read that never finishes still leaves
 * something to write from.
 */
import type { StepBudget } from './budget.ts';
import type { Clock, Hosts } from './fetch/hosts.ts';
import { httpGet, type FetchFn } from './fetch/net.ts';
import { cutDocument, extractPage, paragraphs } from './fetch/page.ts';
import { checkFetchUrl } from './fetch/policy.ts';
import { DOCUMENT_CHARS, FETCH_TIMEOUT_MS, PAGE_ATTEMPTS, PAGE_MAX_BYTES, PAGE_TEXT_MIN } from './limits.ts';
import type { TextScopeName } from './prompts.ts';
import type { TextTier } from './registry.ts';
import type { Store, TextRow } from './store.ts';

export interface ReadEnv {
  readonly store: Store;
  readonly hosts: Hosts;
  readonly fetchFn: FetchFn;
  readonly own: readonly string[];
  readonly budget: StepBudget;
  readonly clock: Clock;
  readonly transact: <T>(fn: () => T) => T;
}

/** What a document's text row starts as: its fallback text and scope, and the page to fetch (empty: none). */
export function initialText(tier: TextTier, fallback: string, link: string, arxiv: string | null): { uri: string; text: string; scope: TextScopeName; state: 'pending' | 'done' } {
  if (tier === 'feed_full') return { uri: '', text: cutDocument(fallback, DOCUMENT_CHARS), scope: 'full_text', state: 'done' };
  if (tier === 'feed_abstract') return { uri: '', text: fallback, scope: 'abstract', state: 'done' };
  if (tier === 'feed_summary' || tier === 'headline') return { uri: '', text: fallback, scope: 'feed_summary', state: 'done' };
  const uri = tier === 'page_full' && arxiv !== null ? `https://arxiv.org/html/${arxiv}` : link;
  return { uri, text: fallback, scope: arxiv !== null || tier === 'page_abstract' ? 'abstract' : 'feed_summary', state: 'pending' };
}

/** The abstract section of a page's text (after a heading or a line that names it), or null. */
export function abstractOf(text: string): string | null {
  const blocks = text.split('\n\n');
  const at = blocks.findIndex((block) => /^(##\s*)?(abstract|summary|摘要)\b[:：]?/i.test(block.trim()));
  if (at < 0) return null;
  const out: string[] = [];
  const first = blocks[at]?.replace(/^(##\s*)?(abstract|summary|摘要)\b[:：]?\s*/i, '').trim() ?? '';
  if (first !== '') out.push(first);
  for (const block of blocks.slice(at + 1)) {
    if (block.startsWith('## ') || out.join('\n\n').length > 3000) break;
    out.push(block);
  }
  const abstract = paragraphs(out.join('\n\n'));
  return abstract.length >= 200 ? abstract.slice(0, 4000) : null;
}

function finish(env: ReadEnv, row: TextRow, changes: { text?: string; scope?: TextScopeName; state: 'done' | 'pending'; attempts: number }): void {
  env.store.run(
    `UPDATE texts SET text = ?, scope = ?, state = ?, attempts = ?, fetched_ms = ? WHERE issue = ? AND doc = ?`,
    changes.text ?? row.text,
    changes.scope ?? row.scope,
    changes.state,
    changes.attempts,
    env.clock.now(),
    row.issue,
    row.doc,
  );
}

/** One alarm's share of an issue's reads; `done` when no document is pending. */
export async function readStep(env: ReadEnv, issue: string, tierOf: (doc: string) => TextTier, waitUntil: number): Promise<{ done: boolean; readyAt: number | null; fetched: number }> {
  let readyAt: number | null = null;
  let fetched = 0;
  const waiting = new Set<string>();
  for (;;) {
    const row = env.store.all<TextRow>(`SELECT * FROM texts WHERE issue = ? AND state = 'pending' ORDER BY doc`, issue).find((candidate) => !waiting.has(candidate.doc));
    if (row === undefined) break;
    if (env.budget.spent(FETCH_TIMEOUT_MS)) return { done: false, readyAt: null, fetched };
    const target = checkFetchUrl(row.uri, env.own);
    if (target === null) {
      env.transact(() => { finish(env, row, { state: 'done', attempts: row.attempts }); });
      continue;
    }
    const answer = await httpGet(env.fetchFn, { url: target, accept: 'text/html, application/xhtml+xml;q=0.9, */*;q=0.5', own: env.own, gate: env.hosts.pageGate(), signal: env.budget.signal, maxBytes: PAGE_MAX_BYTES, truncate: true });
    if (answer.kind === 'refused') {
      if (answer.refusal.kind === 'robots') {
        env.transact(() => { finish(env, row, { state: 'done', attempts: row.attempts }); });
        continue;
      }
      if (answer.refusal.kind === 'budget') return { done: false, readyAt: null, fetched };
      if (answer.refusal.until > waitUntil) {
        env.transact(() => { finish(env, row, { state: 'done', attempts: row.attempts }); });
        continue;
      }
      waiting.add(row.doc);
      readyAt = readyAt === null ? answer.refusal.until : Math.min(readyAt, answer.refusal.until);
      continue;
    }
    fetched++;
    const attempts = row.attempts + 1;
    if (answer.kind === 'failed' || answer.status === 429 || answer.status >= 500) {
      if (answer.kind === 'failed' && answer.failure === 'aborted') return { done: false, readyAt: null, fetched };
      env.transact(() => { finish(env, row, { state: attempts >= PAGE_ATTEMPTS ? 'done' : 'pending', attempts }); });
      if (attempts < PAGE_ATTEMPTS) waiting.add(row.doc);
      continue;
    }
    if (answer.status !== 200) {
      // 404 (no HTML version), 401/402/403 (a paywall or a login): the feed's text, never a workaround.
      env.transact(() => { finish(env, row, { state: 'done', attempts }); });
      continue;
    }
    const text = await extractPage(answer.body, answer.headers.get('content-type'));
    const tier = tierOf(row.doc);
    if (tier === 'page_abstract') {
      const abstract = abstractOf(text);
      env.transact(() => { finish(env, row, abstract === null ? { state: 'done', attempts } : { text: abstract, scope: 'abstract', state: 'done', attempts }); });
      continue;
    }
    if (text.length < PAGE_TEXT_MIN) {
      env.transact(() => { finish(env, row, { state: 'done', attempts }); });
      continue;
    }
    env.transact(() => { finish(env, row, { text: cutDocument(text, DOCUMENT_CHARS), scope: 'full_text', state: 'done', attempts }); });
  }
  const pending = env.store.count(`SELECT count(*) AS n FROM texts WHERE issue = ? AND state = 'pending'`, issue);
  return { done: pending === 0, readyAt, fetched };
}
