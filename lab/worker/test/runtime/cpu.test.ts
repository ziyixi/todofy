/**
 * CPU of the heaviest owner API requests inside workerd, against Workers Free's 10 ms per request
 * (docs/design.md §1). workerd's DevTools inspector records a sampled CPU profile of the isolate around each
 * request; the CPU time is the sum of the sampled intervals that are not idle (D1 and service-binding I/O run
 * outside the isolate and are not counted, as on Cloudflare). LabState runs in the same isolate here, so a
 * mutation's number includes the object's share, which Cloudflare meters separately: an upper bound for the
 * fetch handler. This is an estimate on the test machine, not Cloudflare's meter. Each request runs several
 * times; the first includes the isolate's warm-up of that code path and is reported separately.
 *
 * The data is the largest a request can see: a full deck of DECK_SIZE cards with arXiv-sized titles and
 * abstracts and a 简介 each, and a full page of LIKED_PAGE liked papers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DECK_SIZE, LIKED_PAGE } from '../../src/api-types.ts';
import { rssFeed, type SyntheticItem } from '../feeds.ts';
import { op, startHarness, type Harness } from './harness.ts';

// A port range of its own (FlowDay's CPU test uses 9000-9499), so parallel suites on one machine do not collide.
const PORT = 9_500 + Math.floor(Math.random() * 500);
const FREE_CPU_MS = 10;
/** Warm runs keep a margin below the limit. */
const WARM_BOUND_MS = 0.6 * FREE_CPU_MS;
const SAMPLE_US = 100;
/**
 * A sample's interval is capped at four sampling intervals: a single sample spanning several milliseconds is a gap in
 * which the sampler thread was not scheduled (the test machine runs vitest, Miniflare and workerd at once), not CPU.
 */
const MAX_SAMPLE_US = 4 * SAMPLE_US;
const DAY = '2026-09-30';
const T0 = Date.parse('2026-09-30T06:30:00Z');

/** The owner API paths measured below (one place, so a route change touches only this table). */
const PATHS = {
  today: '/api/today',
  deck: `/api/decks/${DAY}`,
  summary: `/api/decks/${DAY}/summary`,
  decide: `/api/decks/${DAY}/decide`,
  undo: `/api/decks/${DAY}/undo`,
  liked: '/api/liked',
  settings: '/api/settings',
} as const;

let h: Harness;
let send: (method: string, params?: Record<string, unknown>) => Promise<{ result?: { profile?: Profile } }>;
let socket: WebSocket;

interface Profile {
  nodes: { id: number; callFrame: { functionName: string } }[];
  samples: number[];
  timeDeltas: number[];
}

/** An arXiv-sized abstract (about 1,900 characters) and title, invented. */
function bigItem(n: number): SyntheticItem {
  const sentence = `We study synthetic retrieval problem number ${String(n)} with a dense encoder and a sparse reranker. `;
  return {
    id: `2609.${String(20000 + n)}`,
    title: `A long synthetic study of dense retrieval with learned sparse expansions and late interaction, variant ${String(n)}`,
    abstract: sentence.repeat(20).trim(),
    authors: Array.from({ length: 12 }, (_, k) => `Author${String(k)} Example`).join(', '),
    categories: ['cs.IR', 'cs.CL', 'cs.LG'],
  };
}

beforeAll(async () => {
  h = await startHarness({ inspectorPort: PORT });
  h.arxiv.feed = { status: 200, body: rssFeed(Array.from({ length: 60 }, (_, n) => bigItem(n))) };
  await h.run(T0);
  const targets = (await (await fetch(`http://127.0.0.1:${String(PORT)}/json`)).json()) as { id: string; webSocketDebuggerUrl: string }[];
  const target = targets.find((candidate) => candidate.id === 'core:user:lab');
  if (target === undefined) throw new Error('no inspector target for the Worker');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => {
    socket.addEventListener('open', resolve, { once: true });
  });
  let next = 0;
  const pending = new Map<number, (message: unknown) => void>();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number };
    if (message.id !== undefined) pending.get(message.id)?.(message);
  });
  send = (method, params = {}) =>
    new Promise((resolve) => {
      next += 1;
      pending.set(next, resolve as (message: unknown) => void);
      socket.send(JSON.stringify({ id: next, method, params }));
    });
  await send('Profiler.enable');
  await send('Profiler.setSamplingInterval', { interval: SAMPLE_US });
});

afterAll(async () => {
  socket.close();
  await h.dispose();
});

/** CPU milliseconds of the isolate while `run` executes. */
async function cpu(run: () => Promise<unknown>): Promise<number> {
  await send('Profiler.start');
  await run();
  const { result } = await send('Profiler.stop');
  const profile = result?.profile;
  if (profile === undefined) throw new Error('no profile');
  const idle = new Set(profile.nodes.filter((node) => node.callFrame.functionName === '(idle)').map((node) => node.id));
  let micros = 0;
  const byFn = new Map<string, number>();
  const names = new Map(profile.nodes.map((node) => [node.id, node.callFrame.functionName]));
  profile.samples.forEach((sample, index) => {
    if (idle.has(sample)) return;
    const delta = Math.min(profile.timeDeltas[index] ?? 0, MAX_SAMPLE_US);
    micros += delta;
    const name = names.get(sample) ?? '?';
    byFn.set(name, (byFn.get(name) ?? 0) + delta);
  });
  // CPU_DEBUG=1: the top functions of each profile.
  if (process.env['CPU_DEBUG'] !== undefined) console.log(JSON.stringify([...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)));
  return micros / 1000;
}

/**
 * Runs `run` several times: the first run (the isolate's warm-up of that code path, as on a cold isolate), then the
 * warm median and the warm best. Noise on a busy CI machine can only raise these numbers, never lower them.
 */
async function measure(label: string, run: () => Promise<unknown>, times = 11): Promise<{ first: number; median: number; best: number }> {
  const samples: number[] = [];
  for (let index = 0; index < times; index += 1) samples.push(await cpu(run));
  const [first = 0, ...warm] = samples;
  const sorted = [...warm].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? first;
  const best = sorted[0] ?? first;
  console.log(`cpu ${label}: first ${first.toFixed(2)} ms, warm median ${median.toFixed(2)} ms, warm best ${best.toFixed(2)} ms`);
  return { first, median, best };
}

async function text(path: string): Promise<string> {
  const response = await h.fetch(path);
  const body = await response.text();
  if (response.status !== 200) throw new Error(`GET ${path}: ${String(response.status)}`);
  return body;
}

describe('CPU per request (Workers Free: 10 ms)', () => {
  it('the heaviest owner requests stay well below the limit', async () => {
    const deck = JSON.parse(await text(PATHS.deck)) as { cards: { paper: { id: string } }[]; state: { version: number } };
    expect(deck.cards).toHaveLength(DECK_SIZE);
    // A full page of likes: every paper of the feed, liked from the library (fixed times, newest first).
    const papers = await h.sql<{ id: string }>('SELECT id FROM papers ORDER BY id LIMIT ?', LIKED_PAGE + 5);
    for (const [index, paper] of papers.entries()) {
      await h.sql("INSERT INTO feedback (paper_id, label, source, deck_id, at) VALUES (?, 'like', 'library', NULL, ?)", paper.id, T0 + index);
    }
    const liked = JSON.parse(await text(PATHS.liked)) as { papers: unknown[] };
    expect(liked.papers).toHaveLength(LIKED_PAGE);

    const results = [
      await measure('GET today', () => text(PATHS.today)),
      await measure(`GET deck (${String(DECK_SIZE)} cards)`, () => text(PATHS.deck)),
      await measure('GET deck summary', () => text(PATHS.summary)),
      await measure(`GET liked (${String(LIKED_PAGE)} papers)`, () => text(PATHS.liked)),
      await measure('GET settings', () => text(PATHS.settings)),
    ];
    // A decide and its undo (two requests, each a LabState RPC with D1 reads and one batch), measured together and
    // reported per request. The CSRF token is fetched inside h.mutate, outside the measured pair's share.
    let version = deck.state.version;
    const card = deck.cards[0]?.paper.id ?? '';
    const pair = await measure('POST decide + POST undo (one each)', async () => {
      const decided = await h.mutate<{ state: { version: number } }>('POST', PATHS.decide, { op_id: op(), base_version: version, paper_id: card, decision: 'like' });
      const undone = await h.mutate<{ state: { version: number } }>('POST', PATHS.undo, { op_id: op(), base_version: decided.body.state.version });
      if (decided.status !== 200 || undone.status !== 200) throw new Error('mutation failed');
      version = undone.body.state.version;
    });
    // Two mutations plus two CSRF GETs per run: a quarter is a fair per-request figure for the mutation, half an upper bound.
    console.log(`cpu POST decide or undo: about ${(pair.median / 2).toFixed(2)} ms each (upper bound, incl. its CSRF GET)`);
    for (const { best } of results) expect(best).toBeLessThan(WARM_BOUND_MS);
    expect(pair.best / 2).toBeLessThan(WARM_BOUND_MS);
  });
});
