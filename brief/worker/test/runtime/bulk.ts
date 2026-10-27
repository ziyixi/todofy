/**
 * The brief at its bounds, for the CPU and rows suites (../../../docs/design.md §14): a registry of 40 feeds on 40
 * synthetic hosts, each feed just under 1 MiB (50 entries of about 20 KB: research entries carry their full text and a
 * link to an arXiv paper, world entries a long summary), 3 days of world centroids and a week of items that ran, and a
 * fake Claude that answers the pick with the most items its caps allow and the write with the largest answer: every
 * packet written, ten claims a research item and six a world item, each quote one word off its source so that every
 * quote is aligned rather than matched (design §8). All of it synthetic.
 */
import { jsonAnswer, type FakeMessage } from '../fakes/claude.ts';
import type { Harness } from './harness.ts';

export const BULK_SOURCES = 40;
export const FEED_ENTRIES = 50;
/** The entries a feed adds between the baseline round and the measured one: 120 candidates in all. */
export const NEW_ENTRIES = 3;
/** World centroids of the last 3 days, and the items that ran in the last week (the hold-back's vectors). */
export const CENTROIDS = 600;
export const RAN_ITEMS = 70;

const RESEARCH_WORDS = ['seismic', 'agent', 'serving', 'protein'] as const;
const WORLD_WORDS = ['bank', 'ceasefire', 'election', 'trade'] as const;
const ADJECTIVES = ['careful', 'broad', 'direct', 'steady', 'detailed', 'simple', 'robust', 'clear'] as const;
const NOUNS = ['network', 'catalog', 'array', 'benchmark', 'dataset', 'survey', 'archive', 'record'] as const;
/** The word every quote changes: the alignment, never the exact match, finds it. */
const SWAPPED = ['coherent', 'consistent'] as const;
const ENTRY_BYTES = 19_600;

function research(s: number): boolean {
  return s < BULK_SOURCES / 2;
}

export function feedUrl(s: number): string {
  return research(s) ? `https://r${String(s)}.bulk-research.org/feed.xml` : `https://w${String(s)}.bulk-world.net/rss`;
}

/** The registry: half research feeds with full text, half world feeds with summaries. */
export function bulkRegistry(): string {
  const lines = ['version: 1', 'sources:'];
  for (let s = 0; s < BULK_SOURCES; s++) {
    lines.push(
      research(s)
        ? `  - { id: bulk-r${String(s)}, name: Bulk Research ${String(s)}, section: research, kind: rss, url: "${feedUrl(s)}", text: feed_full, review: institution, poll_per_day: 4 }`
        : `  - { id: bulk-w${String(s)}, name: Bulk World ${String(s)}, section: world, kind: rss, url: "${feedUrl(s)}", text: feed_summary, review: news, poll_per_day: 4 }`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Sentence k of research entry e of source s: about 200 characters and 35 words, each one distinct by its numbers. */
function sentence(s: number, e: number, k: number, word: string): string {
  const adjective = ADJECTIVES[(k * 7 + e) % ADJECTIVES.length] ?? 'clear';
  const noun = NOUNS[(k * 3 + s) % NOUNS.length] ?? 'record';
  return `In section ${String(k)} of study ${String(s)}-${String(e)} the ${word} analysis shows that the observed signal stays ${SWAPPED[0]} across the ${adjective} ${noun} while the residual misfit remains small for every station that was tested.`;
}

const SYLLABLES = ['ka', 'lo', 'mi', 'ne', 'ru', 'sa', 'ti', 'vo'] as const;

/** A made-up word of a world story: two world feeds carry each story (sources 2n and 2n + 1), in the same words. */
function storyWord(story: number, slot: number): string {
  let x = Math.imul(story * 97 + slot + 1, 2654435761) >>> 0;
  let word = '';
  for (let i = 0; i < 3; i++, x >>>= 3) word += SYLLABLES[x & 7] ?? 'ka';
  return word;
}

/** Sentence k of world entry e of source s: its story's own words, so that stories cluster apart. */
function worldSentence(s: number, e: number, k: number): string {
  const story = Math.floor(s / 2) * 1000 + e;
  const w = (slot: number): string => storyWord(story, slot + 12 * (k % 4));
  return `In part ${String(k)} ${w(0)} ${w(1)} officials said ${w(2)} ${w(3)} talks stayed ${SWAPPED[0]} while ${w(4)} ${w(5)} traders and ${w(6)} ${w(7)} watchers in ${w(8)} ${w(9)} saw ${w(10)} ${w(11)} markets shift before the vote.`;
}

function entryXml(s: number, e: number, now: number): string {
  const word = research(s) ? (RESEARCH_WORDS[s % RESEARCH_WORDS.length] ?? 'protein') : (WORLD_WORDS[s % WORLD_WORDS.length] ?? 'trade');
  const story = Math.floor(s / 2) * 1000 + e;
  const title = research(s) ? `A ${word} study ${String(s)}-${String(e)} with new synthetic results` : `Officials in ${storyWord(story, 0)} respond to ${word} developments with ${storyWord(story, 1)}`;
  const link = research(s) ? `https://r${String(s)}.bulk-research.org/posts/${String(e)}` : `https://w${String(s)}.bulk-world.net/story/${String(e)}`;
  const paragraphs: string[] = [];
  let length = 0;
  for (let k = 0; length < ENTRY_BYTES - 600; k += 4) {
    const text = [0, 1, 2, 3].map((i) => (research(s) ? sentence(s, e, k + i, word) : worldSentence(s, e, k + i))).join(' ');
    const mention = k === 8 ? ` See <a href="https://arxiv.org/abs/2610.${String(s).padStart(2, '0')}${String(e).padStart(3, '0')}">the preprint</a>.` : '';
    paragraphs.push(`<p>${text}${mention}</p>`);
    length += text.length + mention.length + 7;
  }
  const html = paragraphs.join('');
  const published = new Date(now - (e < NEW_ENTRIES ? 1 : 6) * 3_600_000).toUTCString();
  const content = research(s) ? `<description><![CDATA[A short summary of study ${String(s)}-${String(e)}.]]></description><content:encoded><![CDATA[${html}]]></content:encoded>` : `<description><![CDATA[${html}]]></description>`;
  return `<item><title>${title}</title><link>${link}</link><guid>${link}</guid><pubDate>${published}</pubDate>${content}</item>`;
}

/**
 * The synthetic feeds: `feeds.entries` of each feed's 50 (the newest NEW_ENTRIES are left out of the baseline), dated
 * by the harness's clock. Feeds are built once per entry count and clock hour.
 */
export function serveBulkFeeds(h: Harness): { entries: number } {
  const state = { entries: FEED_ENTRIES - NEW_ENTRIES };
  const cache = new Map<string, string>();
  for (let s = 0; s < BULK_SOURCES; s++) {
    h.web.overrides.set(feedUrl(s), () => {
      const now = h.now();
      const key = `${String(s)}:${String(state.entries)}:${String(Math.floor(now / 3_600_000))}`;
      let body = cache.get(key);
      if (body === undefined) {
        const first = FEED_ENTRIES - state.entries;
        const items = Array.from({ length: state.entries }, (_, i) => entryXml(s, first + i, now)).join('');
        body = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>bulk ${String(s)}</title>${items}</channel></rss>`;
        cache.set(key, body);
      }
      return new Response(body, { headers: { 'content-type': 'application/rss+xml; charset=utf-8' } });
    });
  }
  return state;
}

/** The byte length of one full feed (just under the 1 MiB a feed is read to). */
export function fullFeedBytes(): number {
  const items = Array.from({ length: FEED_ENTRIES }, (_, e) => entryXml(0, e, 0)).join('');
  return new TextEncoder().encode(items).byteLength;
}

/** A deterministic unit vector (xorshift, a sum of uniforms as a rough normal), as little-endian float32 hex. */
function unitHex(seed: number): string {
  let x = (seed * 2654435761) >>> 0 || 1;
  const next = (): number => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
  const vector = new Float32Array(1024);
  let norm = 0;
  for (let i = 0; i < vector.length; i++) {
    const value = next() + next() + next() - 1.5;
    vector[i] = value;
    norm += value * value;
  }
  const scale = 1 / Math.sqrt(norm);
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) * scale;
  return Array.from(new Uint8Array(vector.buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 3 days of world centroids and a week of items that ran, with their vectors, before `now`. */
export async function seedVectors(h: Harness, now: number): Promise<void> {
  const hour = 3_600_000;
  for (let at = 0; at < CENTROIDS; at += 25) {
    const rows = Array.from({ length: Math.min(25, CENTROIDS - at) }, (_, i) => at + i);
    await h.sql(`INSERT INTO clusters (centroid, n, created_ms, updated_ms) VALUES ${rows.map(() => '(unhex(?), 3, ?, ?)').join(', ')}`, ...rows.flatMap((n) => [unitHex(n + 1), now - 70 * hour + n * hour * (70 / CENTROIDS), now - 70 * hour + n * hour * (70 / CENTROIDS)]));
  }
  for (let n = 0; n < RAN_ITEMS; n++) {
    const day = new Date(now - (1 + (n % 6)) * 24 * hour).toISOString().slice(0, 10);
    await h.sql(
      `INSERT INTO items (key, section, title, summary, link, fetched_ms, sources, candidate, text_tier, gate, embedded, ran) VALUES (?, 'research', ?, '', ?, ?, '["seed"]', 1, 'feed_full', 'scored', 1, ?)`,
      `url:https://ran.example.org/${String(n)}`,
      `An item that ran ${String(n)}`,
      `https://ran.example.org/${String(n)}`,
      now - 6 * 24 * hour,
      day,
    );
    await h.sql(`INSERT INTO embeddings (item, vec, ms) VALUES (last_insert_rowid(), unhex(?), ?)`, unitHex(10_000 + n), now - 6 * 24 * hour);
  }
}

/** A JSON block of the request's user message (one line each, as the request builders write them). */
function userJson(body: Record<string, unknown>, marker: string): unknown {
  const content = (typeof body['input'] === 'string' ? body['input'] : '');
  const at = content.indexOf(marker);
  return at < 0 ? null : (JSON.parse(content.slice(at + marker.length).split('\n')[0] ?? 'null') as unknown);
}

/** The pick at its caps: three world cards, and two research cards a topic up to eight items in all. */
export function largestPick(body: Record<string, unknown>): FakeMessage {
  const research = (userJson(body, '研究前沿卡片：\n') ?? []) as { id: string; topic: string }[];
  const world = (userJson(body, '世界与经济卡片：\n') ?? []) as { id: string }[];
  const perTopic = new Map<string, number>();
  const picked: { id: string; reason: string }[] = [];
  const researchMax = 8 - Math.min(3, world.length);
  for (const card of research) {
    const count = perTopic.get(card.topic) ?? 0;
    if (count >= 2 || picked.length >= researchMax) continue;
    perTopic.set(card.topic, count + 1);
    picked.push({ id: card.id, reason: '新数据与新方法' });
  }
  return jsonAnswer({ research: picked, world: world.slice(0, 3).map((card) => ({ id: card.id, reason: '改变局面' })) });
}

const PARAGRAPH = '研究者用新的观测网络检验了这种做法，结果在所有测试台站上都保持一致，残差也一直很小';

/** The largest answer: every packet, ten claims a research item and six a world item, every quote one word off. */
export function largestWrite(body: Record<string, unknown>): FakeMessage {
  const packets = (userJson(body, '材料包：\n') ?? []) as { packet: string; section: string; documents: { doc: string; text: string }[] }[];
  const items = packets.map((packet) => {
    const world = packet.section === '世界与经济';
    const wanted = world ? 6 : 10;
    const pools = packet.documents.map((document) => ({
      doc: document.doc,
      quotes: document.text
        .split(/(?<=\.)\s+/)
        .map((text) => text.trim())
        .filter((text) => text.includes(SWAPPED[0]) && text.length <= 300 && !text.includes('…')),
    }));
    const claims: { n: number; doc: string; quote: string }[] = [];
    const perDocument = Math.ceil(wanted / Math.max(1, pools.length));
    for (const pool of pools) {
      // Spread across the document: its head and its conclusion.
      for (let j = 0; j < perDocument && claims.length < wanted; j++) {
        const quote = pool.quotes[Math.floor((j * pool.quotes.length) / perDocument)];
        if (quote !== undefined) claims.push({ n: claims.length + 1, doc: pool.doc, quote: quote.replace(SWAPPED[0], SWAPPED[1]) });
      }
    }
    const paragraphs = [];
    for (let i = 0; i < claims.length; i += 2) {
      const markers = claims.slice(i, i + 2).map((claim) => `[${String(claim.n)}]`).join('');
      paragraphs.push({ heading: '', text: `${PARAGRAPH}${markers}。` });
    }
    return { packet: packet.packet, section: world ? 'world' : 'research', title: world ? '各方回应新的局势' : '一项新的研究', paragraphs, why: '可用于对比已有的观测结果。', claims };
  });
  return jsonAnswer({ items, omitted: [] }, 'claude-opus-5-5', { inputTokens: 60_000, outputTokens: 12_000 });
}
