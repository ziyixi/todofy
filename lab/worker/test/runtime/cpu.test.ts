/**
 * CPU of the heaviest owner API requests inside workerd, against Workers Free's 10 ms per request
 * (docs/design.md §1), measured and calibrated by the shared meter (tools/workerd-cpu/workerd-cpu.mts): a sampled CPU
 * profile of the Worker's isolate around each request, and the machine's speed from a fixed workload run in the same
 * isolate. LabState runs in the same isolate here, so a mutation's number includes the object's share, which
 * Cloudflare meters separately: an upper bound for the fetch handler.
 *
 * The whole session runs in COLD_ISOLATES fresh isolates (a new harness each, measureInIsolates); every number is
 * divided by its own isolate's speed (never below 1) and the bounds hold each number's median across the isolates, in
 * milliseconds of the reference machine (an Apple M1 Max). A median speed above MAX_SPEED fails the test. What the
 * bounds guard is the cost of lab.ui.v1's shared HTTP runtime (proto/ts: the transcoder, the wire JSON codec, the
 * protobuf-es runtime) before other apps adopt it (proto/README.md "Cost"):
 *
 * - COLD_BOUND_MS: the isolate's first owner API request, the number lab.ui.v1 raised most (the runtime's code paths
 *   run for the first time);
 * - FIRST_BOUND_MS: every other request's first run;
 * - WARM_BOUND_MS: every request's warm median, not its best (a 100 µs sampler that was not scheduled can read a warm
 *   best of 0, and the best of ten finds a quiet moment), with room for the noise of ten runs.
 *
 * The data is the largest a request can see: a full deck of DECK_SIZE cards with arXiv-sized titles and
 * abstracts and a 简介 each, and a full page of LIKED_PAGE liked papers.
 */
import { describe, expect, it } from 'vitest';
import { COLD_ISOLATES, connectCpuMeter, CPU_TEST_TIMEOUT_MS, FREE_CPU_MS, measureInIsolates, type Isolate, type Measurement } from '../../../../tools/workerd-cpu/workerd-cpu.mts';
import { DECK_SIZE, LIKED_PAGE } from '../../src/limits.ts';
import { rssFeed, type SyntheticItem } from '../feeds.ts';
import { op, startHarness, type Harness } from './harness.ts';

const COLD_LABEL = "GET deck as the isolate's first API request";
/**
 * The bound of the isolate's first API request (a 20-card deck), in reference milliseconds. Measured as the median of
 * three isolates: 4.0-5.2 ms on the reference machine (2026-10-01, after ops-v1 moved onto proto/; 3.8-4.0 before);
 * GitHub runners read single isolates 4.2-5.3 ms before that move and 5.7-7.2 after it (their cold runs are about 1.3
 * times the reference machine's once scaled by the warm calibration, tools/workerd-cpu/README.md). So 8.5 ms keeps
 * about a third of headroom above the runners and still fails a regression of 5 ms on the reference machine (an
 * injected 5 ms read 9.8-10.1, README.md), while Free's limit is 10.
 */
const COLD_BOUND_MS = 0.85 * FREE_CPU_MS;
/**
 * The bound of every other request's first run, in reference milliseconds: 2.4-2.9 ms for the first decide and undo,
 * at most 2.2 for the reads (runners: at most 3.6), so a path several times slower fails.
 */
const FIRST_BOUND_MS = 0.7 * FREE_CPU_MS;
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

/** A fresh isolate: a new harness, the feed fetched and the pipeline run, its meter connected. */
interface LabIsolate extends Isolate {
  readonly h: Harness;
}

async function startIsolate(): Promise<LabIsolate> {
  // Port 0: the OS picks a free port, which the meter reads back from Miniflare.
  const h = await startHarness({ inspectorPort: 0 });
  try {
    h.arxiv.feed = { status: 200, body: rssFeed(Array.from({ length: 60 }, (_, n) => bigItem(n))) };
    await h.run(T0);
    const meter = await connectCpuMeter(h.mf, 'lab');
    return {
      h,
      meter,
      async dispose() {
        meter.close();
        await h.dispose();
      },
    };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}

async function text(h: Harness, path: string): Promise<string> {
  const response = await h.fetch(path);
  const body = await response.text();
  if (response.status !== 200) throw new Error(`GET ${path}: ${String(response.status)}`);
  return body;
}

/** One isolate's session: its first API request, then every request's first run and warm runs. */
async function session({ h, meter }: LabIsolate): Promise<Measurement[]> {
  // The isolate's first owner API request (the pipeline already ran in this isolate, so the modules are loaded): what
  // a cold request adds on top of a warm one, the first run of the transcoder, the codec and the protobuf-es runtime
  // (the route table was built at startup).
  const cold = await meter.measure(COLD_LABEL, () => text(h, PATHS.deck), 1);
  const deck = JSON.parse(await text(h, PATHS.deck)) as { cards: { paper: { id: string } }[]; state: { etag: string } };
  expect(deck.cards).toHaveLength(DECK_SIZE);
  // A full page of likes: every paper of the feed, liked from the library (fixed times, newest first).
  const papers = await h.sql<{ id: string }>('SELECT id FROM papers ORDER BY id LIMIT ?', LIKED_PAGE + 5);
  for (const [index, paper] of papers.entries()) {
    await h.sql("INSERT INTO feedback (paper_id, label, source, deck_id, at) VALUES (?, 'like', 'library', NULL, ?)", paper.id, T0 + index);
  }
  const liked = JSON.parse(await text(h, PATHS.liked)) as { liked_papers: unknown[]; next_page_token: string };
  expect(liked.liked_papers).toHaveLength(LIKED_PAGE);
  const nextPage = `${PATHS.liked}?page_token=${encodeURIComponent(liked.next_page_token)}`;

  const requests: Measurement[] = [
    cold,
    await meter.measure('GET today', () => text(h, PATHS.today), RUNS),
    await meter.measure(`GET deck (${String(DECK_SIZE)} cards)`, () => text(h, PATHS.deck), RUNS),
    await meter.measure('GET deck summary', () => text(h, PATHS.summary), RUNS),
    await meter.measure(`GET liked (${String(LIKED_PAGE)} papers)`, () => text(h, PATHS.liked), RUNS),
    await meter.measure('GET liked, filtered by 3 literals', () => text(h, PATHS.likedFiltered), RUNS),
    await meter.measure('GET liked, the next page (page token)', () => text(h, nextPage), RUNS),
    await meter.measure('GET settings', () => text(h, PATHS.settings), RUNS),
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
  return requests;
}


describe('CPU per request (Workers Free: 10 ms)', () => {
  it('the heaviest owner requests stay well below the limit, the first API request of an isolate too', { timeout: CPU_TEST_TIMEOUT_MS }, async () => {
    const { reference } = await measureInIsolates(COLD_ISOLATES, startIsolate, session);
    console.log(
      `cpu bounds (reference ms, medians of ${String(COLD_ISOLATES)} isolates): the isolate's first API request < ${COLD_BOUND_MS.toFixed(2)}, ` +
        `other first runs < ${FIRST_BOUND_MS.toFixed(2)}, warm medians < ${WARM_BOUND_MS.toFixed(2)}`,
    );
    for (const { label, first, median } of reference.values()) {
      if (label === COLD_LABEL) {
        expect(first, label).toBeLessThan(COLD_BOUND_MS);
        continue;
      }
      expect(first, `${label}: first run`).toBeLessThan(FIRST_BOUND_MS);
      expect(median, `${label}: warm median`).toBeLessThan(WARM_BOUND_MS);
    }
  });
});
