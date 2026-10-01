/**
 * CPU of the heaviest owner API requests inside workerd, against Workers Free's 10 ms per request
 * (docs/design.md §1), measured and calibrated by the shared meter (tools/workerd-cpu/workerd-cpu.mts): a sampled CPU
 * profile of the Worker's isolate around each request, and the machine's speed from a fixed workload run in the same
 * isolate. LabState runs in the same isolate here, so a mutation's number includes the object's share, which
 * Cloudflare meters separately: an upper bound for the fetch handler.
 *
 * The bounds are milliseconds of the reference machine (an Apple M1 Max), multiplied by the machine's speed (never
 * below 1); a machine slower than MAX_SPEED fails the test. What they guard is the cost of lab.ui.v1's shared HTTP
 * runtime (proto/ts: the transcoder, the wire JSON codec, the protobuf-es runtime) before other apps adopt it
 * (proto/README.md "Cost"):
 *
 * - COLD_BOUND_MS: the isolate's first owner API request, the number lab.ui.v1 raised most (1.9 -> 3.8-4.0 ms: the
 *   runtime's code paths run for the first time), and the first run of every request measured below;
 * - WARM_BOUND_MS: every request's warm median, not its best (a 100 µs sampler that was not scheduled can read a warm
 *   best of 0, and the best of ten finds a quiet moment), with room for the noise of ten runs.
 *
 * The data is the largest a request can see: a full deck of DECK_SIZE cards with arXiv-sized titles and
 * abstracts and a 简介 each, and a full page of LIKED_PAGE liked papers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectCpuMeter, FREE_CPU_MS, MAX_SPEED, scaleFor, tooSlow, type CpuMeter, type Measurement } from '../../../../tools/workerd-cpu/workerd-cpu.mts';
import { DECK_SIZE, LIKED_PAGE } from '../../src/limits.ts';
import { rssFeed, type SyntheticItem } from '../feeds.ts';
import { op, startHarness, type Harness } from './harness.ts';

// A port range of its own (FlowDay's CPU test uses 9000-9499), so parallel suites on one machine do not collide.
const PORT = 9_500 + Math.floor(Math.random() * 500);
/**
 * The bound of a request's first run, in reference milliseconds. The reference machine measures 3.8-4.0 ms for the
 * isolate's first API request (a 20-card deck) and 2.4-2.9 ms per request for the first decide and undo. A first run
 * is a single measurement, so the bound keeps room for its noise; it still fails at about twice today's cold request,
 * while Free's limit is 10.
 */
const COLD_BOUND_MS = 0.7 * FREE_CPU_MS;
/**
 * The bound of a request's warm median, in reference milliseconds: the heaviest measure 1.4-1.6 ms (a full page of
 * likes, a decide or an undo), so a regression of about 2x fails.
 */
const WARM_BOUND_MS = 0.3 * FREE_CPU_MS;
/** Runs per request: the first (cold) and ten warm ones. */
const RUNS = 11;
const DAY = '2026-09-30';
const T0 = Date.parse('2026-09-30T06:30:00Z');

/** The owner API paths measured below (one place, so a route change touches only this table). */
const PATHS = {
  today: '/api/v1/today',
  deck: `/api/v1/decks/${DAY}`,
  summary: `/api/v1/decks/${DAY}/summary`,
  decide: `/api/v1/decks/${DAY}:decide`,
  undo: `/api/v1/decks/${DAY}:undo`,
  liked: '/api/v1/likedPapers',
  // Three literals of the AIP-160 subset, each a LIKE pattern, all in every synthetic title: a full page.
  likedFiltered: `/api/v1/likedPapers?filter=${encodeURIComponent('"e" AND l i')}`,
  settings: '/api/v1/settings',
} as const;

let h: Harness;
let meter: CpuMeter;

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
  meter = await connectCpuMeter(PORT, 'lab');
});

afterAll(async () => {
  meter.close();
  await h.dispose();
});

async function text(path: string): Promise<string> {
  const response = await h.fetch(path);
  const body = await response.text();
  if (response.status !== 200) throw new Error(`GET ${path}: ${String(response.status)}`);
  return body;
}

describe('CPU per request (Workers Free: 10 ms)', () => {
  it('the heaviest owner requests stay well below the limit, the first API request of an isolate too', async () => {
    // The isolate's first owner API request (the pipeline already ran in this isolate, so the modules are
    // loaded): what a cold request adds on top of a warm one, the first run of the transcoder, the codec and the
    // protobuf-es runtime (the route table was built at startup).
    const cold = await meter.cpu(() => text(PATHS.deck));
    console.log(`cpu GET deck as the isolate's first API request: ${cold.toFixed(2)} ms`);
    const deck = JSON.parse(await text(PATHS.deck)) as { cards: { paper: { id: string } }[]; state: { etag: string } };
    expect(deck.cards).toHaveLength(DECK_SIZE);
    // A full page of likes: every paper of the feed, liked from the library (fixed times, newest first).
    const papers = await h.sql<{ id: string }>('SELECT id FROM papers ORDER BY id LIMIT ?', LIKED_PAGE + 5);
    for (const [index, paper] of papers.entries()) {
      await h.sql("INSERT INTO feedback (paper_id, label, source, deck_id, at) VALUES (?, 'like', 'library', NULL, ?)", paper.id, T0 + index);
    }
    const liked = JSON.parse(await text(PATHS.liked)) as { liked_papers: unknown[]; next_page_token: string };
    expect(liked.liked_papers).toHaveLength(LIKED_PAGE);
    const nextPage = `${PATHS.liked}?page_token=${encodeURIComponent(liked.next_page_token)}`;

    const requests: Measurement[] = [
      await meter.measure('GET today', () => text(PATHS.today), RUNS),
      await meter.measure(`GET deck (${String(DECK_SIZE)} cards)`, () => text(PATHS.deck), RUNS),
      await meter.measure('GET deck summary', () => text(PATHS.summary), RUNS),
      await meter.measure(`GET liked (${String(LIKED_PAGE)} papers)`, () => text(PATHS.liked), RUNS),
      await meter.measure('GET liked, filtered by 3 literals', () => text(PATHS.likedFiltered), RUNS),
      await meter.measure('GET liked, the next page (page token)', () => text(nextPage), RUNS),
      await meter.measure('GET settings', () => text(PATHS.settings), RUNS),
    ];
    // A decide and its undo (two requests, each a LabState RPC with D1 reads and one batch), measured together and
    // bounded per request (the harness fetched the CSRF token once, before the first run).
    let etag = deck.state.etag;
    const card = deck.cards[0]?.paper.id ?? '';
    const pair = await meter.measure('POST decide + POST undo (one each)', async () => {
      const decided = await h.mutate('POST', PATHS.decide, { request_id: op(), etag, paper_id: card, decision: 'like' });
      const after = (await decided.json()) as { state: { etag: string } };
      const undone = await h.mutate('POST', PATHS.undo, { request_id: op(), etag: after.state.etag });
      if (decided.status !== 200 || undone.status !== 200) throw new Error('mutation failed');
      etag = ((await undone.json()) as { state: { etag: string } }).state.etag;
    }, RUNS);
    requests.push({ label: 'POST decide or undo (half of the pair)', first: pair.first / 2, median: pair.median / 2, best: pair.best / 2 });

    // Calibrated after the requests, so that each first run above is still the isolate's first run of its path.
    const calibration = await meter.calibrate();
    const coldBound = COLD_BOUND_MS * scaleFor(calibration.speed);
    const warmBound = WARM_BOUND_MS * scaleFor(calibration.speed);
    console.log(`cpu bounds: first < ${coldBound.toFixed(2)} ms, warm median < ${warmBound.toFixed(2)} ms`);
    expect(calibration.speed, tooSlow(calibration)).toBeLessThanOrEqual(MAX_SPEED);
    expect(cold, "GET deck as the isolate's first API request").toBeLessThan(coldBound);
    for (const { label, first, median } of requests) {
      expect(first, `${label}: first run`).toBeLessThan(coldBound);
      expect(median, `${label}: warm median`).toBeLessThan(warmBound);
    }
  });
});
