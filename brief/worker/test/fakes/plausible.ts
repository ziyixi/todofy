/**
 * A plausible day for the end-to-end dry run (test/runtime/dry-run.test.ts): synthetic article pages that read like the
 * stories their feeds announce (a rate decision, a ceasefire, an inference-serving post), and a fake Claude whose pick
 * and writing look like what Opus would answer: a pick across topics with reasons, and per packet a Chinese item in its
 * format, with verbatim quotes and the numbers, scales, percents and model names the quotes hold. The first answer
 * overstates one number, so the check sends that item to the repair, as a real day would. Everything here was written
 * for the tests: no real article, outlet, address or key.
 */
import type { ClaudeScript, SyntheticWeb } from './upstream.ts';
import { jsonAnswer, type FakeMessage } from './claude.ts';

// ---- the pages -----------------------------------------------------------------------------------------------------------

/** Paragraphs around the facts, so a page reads as an article (fetch/page.ts wants PAGE_TEXT_MIN characters). */
const BANK_BACKGROUND = [
  'Analysts had spent the week comparing the decision with the path the bank set out in its spring outlook, and with the views of its own committee members.',
  'The statement repeated that future moves would depend on the data, and that the committee would meet again after the next quarterly report is published.',
  'Officials from neighbouring economies said they were watching closely, because their own currencies and their exporters depend on what happens here.',
  'Reporters asked about the effect on households, on small firms that borrow at variable rates, and on the public debt that falls due later this year.',
  'Opposition politicians called for a clearer explanation, while business groups said that the decision had been expected by most of their members.',
  'The reaction in the markets was calm by the end of the day, and traders said they would wait for the next round of data before changing their views.',
];

const TALKS_BACKGROUND = [
  'The talks were held in a neutral capital, with mediators from three countries shuttling between the delegations in separate rooms of the same hotel.',
  'Earlier attempts at a truce collapsed within days, and residents near the front line said they would believe the agreement when the shelling stopped.',
  'Aid groups said that fuel, medicine and clean water were the most urgent needs, and that convoys were ready to move as soon as the crossings opened.',
  'Both governments presented the agreement as a victory at home, and both said that their forces would respond to any violation of the terms.',
  'The monitoring team will report to the mediators every week, and its first report is expected before the second round of talks begins.',
  'Analysts cautioned that similar agreements in the region had held only when outside powers kept up pressure on both sides for many months.',
];

const LAB_BACKGROUND = [
  'This post describes the serving setup we use in production, the measurements behind it, and the cases where the technique does not pay for itself.',
  'Each request is served by one replica of the target model, and the draft model runs on the same accelerator, so no extra network hop is involved.',
  'We measured every configuration on the same traffic replay, with prompts and completions sampled from a week of anonymized synthetic requests.',
  'The code for the scheduler and the verification kernel is available, together with the scripts that reproduce every number in this post.',
  'We would like to thank the infrastructure team for their help with the benchmark harness and the many careful reviews of the kernel changes.',
  'In a later post we will look at tree-shaped drafts, which verify several candidate continuations at once, and at how they interact with batching.',
];

function page(title: string, paragraphs: readonly string[], background: readonly string[]): Response {
  const body = [...paragraphs, ...background].map((paragraph) => `<p>${paragraph}</p>`).join('');
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><nav>Home · World</nav><article><h1>${title}</h1>${body}</article><footer>Synthetic footer</footer></body></html>`, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

const BANK = [
  'The central bank of a synthetic economy raised its policy rate by 0.5 percentage points on Thursday, to 4.25 percent.',
  'It was the first increase in 4 years, and most of the 30 economists polled before the decision had expected no change.',
  'The bank said that inflation had stayed above its 2 percent target for 18 months.',
  'Mortgage rates are likely to follow within weeks, the governor told reporters after the meeting.',
];

const CEASEFIRE = [
  'Both sides agreed to a ceasefire starting at midnight, after talks that lasted 9 days.',
  'The agreement opens two crossings for aid convoys and sets up a joint monitoring team of 40 observers.',
  'The conflict has displaced about 1.3 million people since it began, according to a relief agency.',
  'Diplomats said the hardest questions, on borders and on prisoners, were left for a second round of talks.',
];

const SERVING = [
  'Speculative decoding with a 1B draft model cuts median latency by 38 percent on H100 GPUs.',
  'The draft model proposes 4 tokens at a time, and the target model accepts 71 percent of them on average.',
  'Throughput rises from 2,400 to 3,900 tokens per second at a batch size of 32.',
  'The gain shrinks for long prompts, where attention over the KV cache dominates the cost.',
];

/** Registers the pages of the days around `from` (the feeds' links carry the UTC day of the poll). */
export function plausiblePages(web: SyntheticWeb, from: number, days = 4): void {
  const first = Math.floor(from / 86_400_000) - 1;
  for (let day = first; day <= first + days; day++) {
    web.overrides.set(`https://news.synthetic-wire.net/world/bank-${String(day)}`, () => page('Central bank raises its policy rate in a surprise move', BANK, BANK_BACKGROUND));
    web.overrides.set(`https://news.synthetic-wire.net/world/ceasefire-${String(day)}`, () => page('Ceasefire agreed in a long regional conflict', CEASEFIRE, TALKS_BACKGROUND));
    for (let i = 0; i < 2; i++) web.overrides.set(`https://lab.synthetic-ai.org/blog/post-${String(day * 10 + i)}`, () => page('Inference serving with speculative decoding', SERVING, LAB_BACKGROUND));
  }
}

// ---- how a writer would say each sentence ---------------------------------------------------------------------------------

interface Phrase {
  /** A fragment of a source sentence (the synthetic web's or the pages above). */
  readonly match: RegExp;
  /** The Chinese sentence, its numbers as the source has them (scales and percents converted, never invented). */
  readonly zh: string;
  /** A title when this sentence leads the item. */
  readonly title: string;
}

const PHRASES: readonly Phrase[] = [
  // The synthetic web's research sentences (test/fakes/upstream.ts SENTENCES).
  { match: /resolves low-velocity anomalies beneath the plate down to 410 km depth/, zh: '新模型分辨出板块下方深至 410 公里的低速异常', title: '层析成像看清板块下方的低速异常' },
  { match: /waveform misfit falls by 23\.4 percent across the test stations/, zh: '与以往模型相比，测试台站上的波形失配降低了 23.4%', title: '新速度模型明显降低波形失配' },
  { match: /scales to 1\.2 million seismograms on a single GPU node/, zh: '作者报告，这一方法在单个 GPU 节点上可处理 120 万条地震记录', title: '单个 GPU 节点上的大规模波形反演' },
  { match: /held-out catalog of 5,000 events confirms the improvement/, zh: '在留出的 5000 个事件上，震源定位同样更准', title: '留出目录验证震源定位的改进' },
  { match: /Slow slip events release stress over weeks rather than seconds/, zh: '钻孔应变仪显示，慢滑移在数周而不是数秒内释放应力', title: '慢滑移在数周内释放应力' },
  { match: /learned prior over velocity structure trained on synthetic data/, zh: '作者把提升归因于在合成数据上训练的速度结构先验', title: '用合成数据学到的速度先验' },
  // The serving post.
  { match: /1B draft model cuts median latency by 38 percent on H100 GPUs/, zh: '用 1B 参数的草稿模型做推测解码，在 H100 上把中位延迟降低了 38%', title: '小草稿模型让推测解码延迟明显下降' },
  { match: /proposes 4 tokens at a time, and the target model accepts 71 percent/, zh: '草稿模型每次提出 4 个 token，目标模型平均接受其中的 71%', title: '草稿模型的接受率决定推测解码的收益' },
  { match: /from 2,400 to 3,900 tokens per second at a batch size of 32/, zh: '批大小为 32 时，吞吐量从每秒 2400 个 token 提高到 3900 个', title: '推测解码提高大批量推理吞吐' },
  { match: /gain shrinks for long prompts, where attention over the KV cache dominates/, zh: '提示很长时，KV cache 上的注意力占了大部分开销，收益随之变小', title: '长提示下推测解码的收益变小' },
  // The rate decision: the article, and the summary of a second outlet.
  { match: /raised its policy rate by 0\.5 percentage points on Thursday, to 4\.25 percent/, zh: '央行意外把政策利率上调 0.5 个百分点，至 4.25%', title: '央行意外加息，结束多年按兵不动' },
  { match: /first increase in 4 years, and most of the 30 economists/, zh: '这是 4 年来的首次加息，受访的 30 位经济学家大多预期利率不变', title: '央行多年来首次加息' },
  { match: /above its 2 percent target for 18 months/, zh: '央行表示，通胀已连续 18 个月高于 2% 的目标', title: '通胀长期高于目标，央行加息' },
  { match: /Mortgage rates are likely to follow within weeks/, zh: '行长会后对记者说，房贷利率可能在几周内跟着上调', title: '房贷利率可能跟着上调' },
  { match: /raised its policy rate by 0\.5 percentage points, the first rise in 4 years/, zh: '央行把政策利率上调 0.5 个百分点，是 4 年来首次加息', title: '央行多年来首次加息' },
  // The ceasefire.
  { match: /ceasefire starting at midnight, after talks that lasted 9 days/, zh: '经过 9 天的谈判，冲突双方同意自午夜起停火', title: '长期冲突双方同意停火' },
  { match: /opens two crossings for aid convoys and sets up a joint monitoring team of 40 observers/, zh: '协议开放两个口岸供援助车队通行，并设立由 40 名观察员组成的联合监督小组', title: '停火协议开放援助通道' },
  { match: /displaced about 1\.3 million people/, zh: '据一家救援机构统计，冲突爆发以来约 130 万人流离失所', title: '冲突已致大量人口流离失所' },
];

/** Why it matters to this reader, per topic (the policy's one concrete sentence, no numbers). */
const WHY: Readonly<Record<string, string>> = {
  'geo.seismology': '可以直接对照你所用速度模型在俯冲带下方的分辨率。',
  'geo.earth': '与断层和地幔结构的观测直接相关。',
  'llm.systems': '推理服务里延迟与吞吐的取舍，正是你关心的效率问题。',
  'llm.agents': '说明智能体在真实任务上能做到什么。',
  'world.economy': '利率变化会传到房贷、汇率与市场预期。',
  'world.affairs': '停火若能维持，援助与人员流动都会随之变化。',
  'world.disaster': '破坏性地震的规模与影响范围。',
};

const PICK_REASONS: Readonly<Record<string, string>> = {
  'geo.seismology': '新数据与新方法，直接改进俯冲带成像',
  'llm.systems': '推理延迟明显下降，做法简单、可以复用',
  'llm.agents': '智能体评测的新证据',
  'world.economy': '多年来首次加息，影响面广',
  'world.affairs': '停火可能改变地区局势',
};

/** The research topics a plausible pick takes, in this order, at most 2 each; and the world topics. */
const RESEARCH_ORDER = ['geo.seismology', 'llm.systems'];
const WORLD_ORDER = ['world.economy', 'world.affairs'];

/** The minimum claims per format word (design §6), as the writer reads the packet. */
const MINIMUM: Readonly<Record<string, number>> = { 专业: 1, 熟悉: 2, 通俗: 2, '世界·短': 1 };
/** How many claims a plausible item cites per format. */
const CLAIMS: Readonly<Record<string, number>> = { 专业: 2, 熟悉: 2, 通俗: 3, '世界·短': 2 };

/** The whole sentence (or sentences) of a source text around a match: a verbatim quote. */
function quoteAround(text: string, from: number, to: number): string {
  let start = from;
  while (start > 0 && text[start - 1] !== '\n' && !/[.!?]\s$/.test(text.slice(start - 2, start))) start--;
  let end = to;
  while (end < text.length && !(/[.!?]/.test(text[end - 1] ?? '') && /\s/.test(text[end] ?? ' '))) end++;
  return text.slice(start, end).trim();
}

interface PacketJson {
  readonly packet: string;
  readonly section: string;
  readonly topic: string;
  readonly format: string;
  readonly documents: readonly { readonly doc: string; readonly text: string }[];
}

interface Found {
  readonly doc: string;
  readonly quote: string;
  readonly phrase: Phrase;
}

/** The sentences of a packet a writer can say, in document and text order. */
function sayable(packet: PacketJson): Found[] {
  const found: (Found & { at: number; order: number })[] = [];
  packet.documents.forEach((document, order) => {
    for (const phrase of PHRASES) {
      const match = phrase.match.exec(document.text);
      if (match === null || found.some((entry) => entry.phrase.zh === phrase.zh)) continue;
      found.push({ doc: document.doc, quote: quoteAround(document.text, match.index, match.index + match[0].length), phrase, at: match.index, order });
    }
  });
  return found.sort((a, b) => a.order - b.order || a.at - b.at);
}

/**
 * One packet as a writer would write it in its format, or null when its texts hold too little (omitted as `thin`). The
 * second packet of a topic leads with the next sentence (`turn`): two papers over similar texts get different titles.
 * `overstate` adds a sentence whose number no quote holds (`3 倍`): the check's number_unsupported.
 */
function write(packet: PacketJson, turn: number, overstate: boolean): Record<string, unknown> | null {
  const all = sayable(packet);
  if (all.length < (MINIMUM[packet.format] ?? 2)) return null;
  const ordered = [...all.slice(turn % all.length), ...all.slice(0, turn % all.length)];
  const chosen = ordered.slice(0, CLAIMS[packet.format] ?? 2);
  // A research item cites its primary document (its only one); a world item's first claim is its lead article's.
  const claims = chosen.map((entry, i) => ({ n: i + 1, doc: entry.doc, quote: entry.quote }));
  const sentence = (i: number): string => `${chosen[i]?.phrase.zh ?? ''}[${String(i + 1)}]。`;
  const paragraphs =
    packet.format === '通俗' && chosen.length > 2
      ? [{ heading: '', text: `${sentence(0)}${sentence(1)}` }, { heading: '', text: chosen.slice(2).map((_, i) => sentence(i + 2)).join('') }]
      : [{ heading: '', text: chosen.map((_, i) => sentence(i)).join('') }];
  if (overstate && paragraphs[0] !== undefined) paragraphs[0] = { heading: '', text: `${paragraphs[0].text}效率因此提高了 3 倍[1]。` };
  return {
    packet: packet.packet,
    section: packet.section === '世界与经济' ? 'world' : 'research',
    title: chosen[0]?.phrase.title ?? '',
    paragraphs,
    why: WHY[packet.topic] ?? '与你的阅读方向相关。',
    claims,
  };
}

function userJson(body: Record<string, unknown>, marker: string): unknown {
  const content = (body['messages'] as { content: string }[])[0]?.content ?? '';
  const at = content.indexOf(marker);
  return at < 0 ? null : (JSON.parse(content.slice(at + marker.length).split('\n')[0] ?? 'null') as unknown);
}

/**
 * The fake Claude of a plausible day: the pick and the writing as above (the first write overstates its first item),
 * the repair rewrites what it is given without the overstatement, the log finds every claim supported; the gate falls
 * through to the default fake. The usage is of the size design §13 estimates.
 */
export function plausibleClaude(): ClaudeScript {
  // Each packet's turn, from the write, for the repair that rewrites it.
  const turns = new Map<string, number>();
  const answer = (value: unknown, model: string, usage: FakeMessage['usage']): FakeMessage => jsonAnswer(value, model, usage);
  return (body, step) => {
    const model = String(body['model']);
    if (step === 'pick') {
      const research = userJson(body, '研究前沿卡片：\n') as { id: string; topic: string }[];
      const world = userJson(body, '世界与经济卡片：\n') as { id: string; topic: string }[];
      const take = (cards: { id: string; topic: string }[], topics: readonly string[], perTopic: number) =>
        topics.flatMap((topic) => cards.filter((card) => card.topic === topic).slice(0, perTopic)).map((card) => ({ id: card.id, reason: PICK_REASONS[card.topic] ?? '值得一读' }));
      return answer({ research: take(research, RESEARCH_ORDER, 2), world: take(world, WORLD_ORDER, 1) }, model, { input_tokens: 15_000, output_tokens: 6_000 });
    }
    if (step === 'write') {
      const packets = userJson(body, '材料包：\n') as PacketJson[];
      packets.forEach((packet, i) => turns.set(packet.packet, packets.slice(0, i).filter((other) => other.topic === packet.topic).length));
      const items = packets.map((packet, i) => ({ packet, item: write(packet, turns.get(packet.packet) ?? 0, i === 0) }));
      return answer(
        { items: items.flatMap((entry) => (entry.item === null ? [] : [entry.item])), omitted: items.filter((entry) => entry.item === null).map((entry) => ({ packet: entry.packet.packet, code: 'thin' })) },
        model,
        { input_tokens: 30_000, output_tokens: 22_000, cache_creation_input_tokens: 3_500 },
      );
    }
    if (step === 'repair') {
      const cases = userJson(body, '需要修订的条目：\n') as { packet: PacketJson; problems: string[] }[];
      return answer({ items: cases.flatMap((entry) => write(entry.packet, turns.get(entry.packet.packet) ?? 0, false) ?? []), omitted: [] }, model, { input_tokens: 6_000, output_tokens: 4_000, cache_read_input_tokens: 3_500 });
    }
    if (step === 'entail') {
      const cases = JSON.parse((body['messages'] as { content: string }[])[0]?.content ?? '[]') as { item: string; n: number }[];
      return answer({ verdicts: cases.map((entry) => ({ item: entry.item, n: entry.n, verdict: 'supported' })) }, model, { input_tokens: 9_000, output_tokens: 1_500 });
    }
    return null;
  };
}
