/**
 * Per-host pacing (../../../docs/design.md §3.2): one request at a time per host (the object makes its requests one
 * after another), at least HOST_SPACING_MS apart or the host's Crawl-delay; 429 and 503 back off for Retry-After or
 * HOST_BACKOFF_MS doubling. A host that is not ready defers its sources to a later alarm, never a failure: a short wait
 * is slept through inside the step (its wall time permitting), a longer one ends the request with `host` and the time
 * it is ready. Every request takes one of the step's subrequests first.
 *
 * Page requests (full text) also check the host's robots.txt for the brief's own token (robots.ts), read through the
 * same pacing and cached ROBOTS_TTL_MS in the host's row.
 */
import type { StepBudget } from '../budget.ts';
import { FETCH_TIMEOUT_MS, HOST_BACKOFF_MAX_MS, HOST_BACKOFF_MS, HOST_SPACING_MS, HOST_WAIT_SLEEP_MAX_MS, ROBOTS_ERROR_TTL_MS, ROBOTS_MAX_BYTES, ROBOTS_TTL_MS } from '../limits.ts';
import type { HostRow, Store } from '../store.ts';
import { httpGet, type FetchFn, type Gate, type GateRefusal } from './net.ts';
import { robotsAllows, robotsFromAnswer, type RobotsVerdict } from './robots.ts';

/** The clock the fetchers read and sleep on (the tests' manual clock advances on sleep instead of waiting). */
export interface Clock {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<boolean>;
}

/** Retry-After in milliseconds (seconds or an HTTP date), or null. */
export function retryAfterMs(value: string | null, now: number): number | null {
  if (value === null || value.trim() === '') return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

const EMPTY_ROW = { next_ms: 0, backoff_ms: 0, backoff_until_ms: 0, crawl_delay_ms: 0, robots: '', robots_until_ms: 0 };

export class Hosts {
  private readonly rows = new Map<string, HostRow>();
  private readonly store: Store;
  private readonly budget: StepBudget;
  private readonly clock: Clock;
  private readonly fetchFn: FetchFn;
  private readonly own: readonly string[];

  constructor(store: Store, budget: StepBudget, clock: Clock, fetchFn: FetchFn, own: readonly string[]) {
    this.store = store;
    this.budget = budget;
    this.clock = clock;
    this.fetchFn = fetchFn;
    this.own = own;
  }

  row(host: string): HostRow {
    let row = this.rows.get(host);
    if (row === undefined) {
      row = this.store.one<HostRow>(`SELECT * FROM hosts WHERE host = ?`, host) ?? { host, ...EMPTY_ROW };
      this.rows.set(host, row);
    }
    return row;
  }

  private save(row: HostRow): void {
    this.rows.set(row.host, row);
    this.store.run(
      `INSERT INTO hosts (host, next_ms, backoff_ms, backoff_until_ms, crawl_delay_ms, robots, robots_until_ms) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (host) DO UPDATE SET next_ms = excluded.next_ms, backoff_ms = excluded.backoff_ms, backoff_until_ms = excluded.backoff_until_ms,
         crawl_delay_ms = excluded.crawl_delay_ms, robots = excluded.robots, robots_until_ms = excluded.robots_until_ms`,
      row.host,
      row.next_ms,
      row.backoff_ms,
      row.backoff_until_ms,
      row.crawl_delay_ms,
      row.robots,
      row.robots_until_ms,
    );
  }

  /** When `host` may be asked next (its backoff and spacing), 0 when now. */
  readyAt(host: string): number {
    const row = this.row(host);
    const at = Math.max(row.next_ms, row.backoff_until_ms);
    return at <= this.clock.now() ? 0 : at;
  }

  private async pace(url: URL): Promise<GateRefusal | null> {
    if (!this.budget.take()) return { kind: 'budget' };
    const row = this.row(url.hostname);
    const now = this.clock.now();
    if (row.backoff_until_ms > now) {
      this.budget.give();
      return { kind: 'host', until: row.backoff_until_ms };
    }
    const wait = row.next_ms - now;
    if (wait > 0) {
      if (wait > HOST_WAIT_SLEEP_MAX_MS || this.budget.timeLeft() < wait + FETCH_TIMEOUT_MS || !(await this.clock.sleep(wait, this.budget.signal))) {
        this.budget.give();
        return { kind: 'host', until: row.next_ms };
      }
    }
    return null;
  }

  private settle(url: URL, status: number, headers: Headers | null): void {
    const row = { ...this.row(url.hostname) };
    const now = this.clock.now();
    row.next_ms = now + Math.max(HOST_SPACING_MS, row.crawl_delay_ms);
    if (status === 429 || status === 503) {
      const backoff = row.backoff_ms > 0 ? Math.min(HOST_BACKOFF_MAX_MS, row.backoff_ms * 2) : HOST_BACKOFF_MS;
      const after = retryAfterMs(headers?.get('retry-after') ?? null, now);
      row.backoff_ms = backoff;
      row.backoff_until_ms = now + Math.min(HOST_BACKOFF_MAX_MS, Math.max(after ?? 0, backoff));
    } else if (status >= 200 && status < 500) {
      row.backoff_ms = 0;
      row.backoff_until_ms = 0;
    }
    this.save(row);
  }

  /** The gate of feed and API requests: pacing only. */
  feedGate(): Gate {
    return {
      enter: (url) => this.pace(url),
      leave: (url, status, headers) => {
        this.settle(url, status, headers);
      },
    };
  }

  /** The verdict of `host`'s robots.txt for the brief, read (paced) when the cached one expired. */
  async robots(host: string): Promise<RobotsVerdict | GateRefusal> {
    const row = this.row(host);
    const now = this.clock.now();
    if (row.robots !== '' && row.robots_until_ms > now) {
      try {
        return JSON.parse(row.robots) as RobotsVerdict;
      } catch {
        // Read it again.
      }
    }
    const answer = await httpGet(this.fetchFn, {
      url: new URL(`https://${host}/robots.txt`),
      accept: 'text/plain, */*;q=0.5',
      own: this.own,
      gate: this.feedGate(),
      signal: this.budget.signal,
      maxBytes: ROBOTS_MAX_BYTES,
      truncate: true,
    });
    if (answer.kind === 'refused') return answer.refusal;
    if (answer.kind === 'failed' && answer.failure === 'aborted') return { kind: 'budget' };
    const verdict = answer.kind === 'answer' ? robotsFromAnswer(answer.status, new TextDecoder().decode(answer.body)) : robotsFromAnswer(0, null);
    const fresh = { ...this.row(host) };
    fresh.robots = JSON.stringify(verdict);
    fresh.robots_until_ms = this.clock.now() + (verdict.disallowAll ? ROBOTS_ERROR_TTL_MS : ROBOTS_TTL_MS);
    fresh.crawl_delay_ms = verdict.crawlDelayMs;
    this.save(fresh);
    return verdict;
  }

  /** The gate of page requests: the host's robots.txt for the brief's token, then pacing. */
  pageGate(): Gate {
    return {
      enter: async (url) => {
        const verdict = await this.robots(url.hostname);
        if ('kind' in verdict) return verdict;
        if (!robotsAllows(verdict, `${url.pathname}${url.search}`)) return { kind: 'robots' };
        return this.pace(url);
      },
      leave: (url, status, headers) => {
        this.settle(url, status, headers);
      },
    };
  }
}
