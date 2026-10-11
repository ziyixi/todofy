/**
 * The email (../../docs/design.md §10, §11): golden renders of synthetic issues (a weekday brief, a Saturday deep read,
 * a quiet day's note), compared with test/golden/email-*.html and .txt byte for byte, and the properties every render
 * keeps: the same words in both parts, verifiable feedback links on every item, the source line by code, Chinese
 * typography, nothing remote, a dark scheme for every coloured element, and the size at the issue's bounds.
 * `UPDATE_GOLDEN=1 npx vitest run test/render.test.ts` rewrites the golden files; only for an intended change. All
 * titles, texts, venues and links are synthetic.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { feedbackKey, verifyFeedback, VOTES } from '../src/feedback.ts';
import { EMAIL_HTML_MAX } from '../src/limits.ts';
import { REVIEW_WORDS } from '../src/prompts.ts';
import { REVIEWS } from '../src/registry.ts';
import { escapeHtml, modelName, QUIET_WORDS, renderEmail, sourceLine, typeset, type FinalItem, type MoreItem, type QuietReasonName, type Reference, type RenderInput } from '../src/render.ts';

const KEY = 'ab'.repeat(32);
// Monday 2026-10-12, 06:30 in Los Angeles (PDT).
const NOW = Date.parse('2026-10-12T13:30:00Z');
const HOST = 'brief.example.org';

const path = (name: string): string => decodeURIComponent(new URL(`golden/${name}`, import.meta.url).pathname);

function golden(name: string, actual: string): void {
  if (process.env['UPDATE_GOLDEN'] === '1') writeFileSync(path(name), actual);
  expect(actual, name).toBe(readFileSync(path(name), 'utf8'));
}

function ref(overrides: Partial<Reference> = {}): Reference {
  return { source: 'synthetic-journal', venue: 'Synthetic Journal of Seismology', title: 'A synthetic study', uri: 'https://doi.org/10.5555/synthetic.0001', review: 'peer_reviewed', scope: 'abstract', published: null, ...overrides };
}

function item(overrides: Partial<FinalItem> = {}): FinalItem {
  return {
    id: 'r1',
    section: 'research',
    topic: 'geo.seismology',
    format: 'professional',
    title: '标题',
    paragraphs: [{ heading: '', text: '正文[1]。' }],
    why: '',
    refs: [ref()],
    citations: [{ n: 1, ref: 0, quote: 'A synthetic quote that is long enough to cite', verdict: '' }],
    reason: '',
    score: 8,
    keys: ['doi:10.5555/synthetic.0001'],
    sources: ['synthetic-journal'],
    ...overrides,
  };
}

function input(overrides: Partial<RenderInput> = {}): RenderInput {
  return { date: '2026-10-12', shadow: false, items: [], more: [], costUsd: 0, writers: ['claude-opus-5-5'], publicHost: HOST, feedbackKeyHex: KEY, now: NOW, quiet: null, ...overrides };
}

// ---- the synthetic issues -----------------------------------------------------------------------------------------------------

const WEEKDAY_ITEMS: FinalItem[] = [
  item({
    title: '密集台阵揭示走滑断层浅部的低速带',
    paragraphs: [{ heading: '', text: '作者用2400个节点台站的环境噪声互相关反演断层两侧的S波速度，发现浅部存在宽约200米的低速带，并随深度在3公里内收窄[1]。' }],
    why: '可作为走滑断层带浅部结构的直接约束。',
    refs: [ref({ venue: 'Synthetic Journal of Seismology', uri: 'https://doi.org/10.5555/synthetic.0001' })],
  }),
  item({
    id: 'r2',
    topic: 'llm.systems',
    format: 'familiar',
    title: '长上下文下推测解码的瓶颈转到KV cache',
    paragraphs: [
      { heading: '', text: '研究者测量了推测解码在长上下文中的收益，发现上下文超过32K后，草稿模型节省的时间被读取KV cache的开销抵消[1]。' },
      { heading: '', text: '他们让草稿模型共享目标模型的缓存，作者报告在同样硬件上吞吐提高约30%的同时输出不变 [2]。' },
    ],
    why: '长上下文推理的提速瓶颈在缓存读取，不在草稿模型。',
    refs: [
      ref({ source: 'synthetic-preprints', venue: 'Synthetic Preprints', title: 'Speculative decoding at long context', uri: 'https://papers.synthetic-preprints.org/abs/2610.00001', review: 'preprint', scope: 'full_text' }),
      ref({ source: 'synthetic-lab-blog', venue: 'Synthetic Lab Blog', title: 'Notes on cache sharing', uri: 'https://blog.synthetic-lab.org/posts/cache-sharing', review: 'institution', scope: 'feed_summary' }),
    ],
    citations: [
      { n: 1, ref: 0, quote: 'beyond 32K tokens the time saved by drafting is offset by cache reads', verdict: '' },
      { n: 2, ref: 0, quote: 'throughput improves by 30% with identical outputs', verdict: '' },
    ],
  }),
  item({
    id: 'r3',
    topic: 'ai4sci',
    format: 'plain',
    title: '神经算子把 <偏微分方程> 求解变快 & 变便宜',
    paragraphs: [
      { heading: '', text: '神经算子是一类直接学习“输入场到输出场”映射的模型[1]。这项工作用它代替数值求解器中最慢的一步，在合成流体算例上把计算时间缩短到原来的10%以下[2]。' },
    ],
    why: '物理约束模型的思路可能迁移到波场模拟。',
    refs: [ref({ venue: 'Synthetic Computational Physics', uri: 'https://journal.synthetic-physics.org/articles/0042' })],
    citations: [
      { n: 1, ref: 0, quote: 'neural operators learn the map from input fields to output fields', verdict: '' },
      { n: 2, ref: 0, quote: 'cutting the solve time to under 10% of the baseline solver', verdict: '' },
    ],
  }),
  item({
    id: 'w1',
    section: 'world',
    topic: 'world.economy',
    format: 'world_short',
    title: '一家合成央行多年来首次降息',
    paragraphs: [{ heading: '', text: '合成央行把基准利率下调0.25个百分点至4%，这是它多年来首次转向宽松[1]。' }],
    why: '利率转向会影响全球借贷成本。',
    refs: [ref({ source: 'synthetic-wire', venue: 'Synthetic Wire', title: 'Synthetic central bank cuts rates', uri: 'https://news.synthetic-wire.net/world/0001', review: 'news', scope: 'feed_summary' })],
  }),
  item({
    id: 'w2',
    section: 'world',
    topic: 'world.affairs',
    format: 'plain',
    title: '两国在合成边境达成停火',
    paragraphs: [{ heading: '', text: '双方同意从周一起停火并交换战俘，联合监督机制由第三国组成[1]。此前三个月的冲突已让沿线超过20万人离开家园[2]。' }],
    why: '停火若维持，将改变地区局势。',
    refs: [
      ref({ source: 'synthetic-daily', venue: 'Synthetic Daily', title: 'Ceasefire agreed', uri: 'https://www.synthetic-daily.org/world/ceasefire', review: 'news', scope: 'feed_summary' }),
      ref({ source: 'synthetic-wire', venue: 'Synthetic Wire', title: 'Ceasefire details', uri: 'https://news.synthetic-wire.net/world/0002', review: 'news', scope: 'full_text' }),
    ],
    citations: [
      { n: 1, ref: 0, quote: 'both sides agreed to a ceasefire from Monday and an exchange of prisoners', verdict: '' },
      { n: 2, ref: 1, quote: 'more than 200,000 people along the border have left their homes', verdict: '' },
    ],
  }),
];

const WEEKDAY_MORE: MoreItem[] = [
  { source: 'synthetic-journal', title: 'A synthetic catalogue of slow-slip events beneath a subduction margin', venue: 'Synthetic Journal of Seismology', review: 'peer_reviewed', uri: 'https://doi.org/10.5555/synthetic.0002' },
  { source: 'synthetic-preprints', title: 'Synthetic waveform benchmark for phase picking', venue: 'Synthetic Preprints', review: 'preprint', uri: 'http://papers.synthetic-preprints.org/abs/2610.00002' },
];

const DEEP_ITEM: FinalItem = item({
  id: 'deep',
  section: 'deep_read',
  topic: 'geo.earth',
  format: 'familiar',
  title: '慢滑移如何为大地震蓄力',
  paragraphs: [
    { heading: '原来的认识', text: '过去十年，大地测量在多条俯冲带上记录到持续数周的慢滑移事件，它们释放的能量相当于中等地震，却几乎不产生地震波[1]。' },
    { heading: '', text: '一种看法认为慢滑移只是应力的“泄压阀”，另一种看法认为它会把应力转移到相邻的闭锁段[2]。' },
    { heading: '新的证据', text: '这次的合成研究把GNSS位移与重复地震目录放在一起，发现主震前两年慢滑移的频率增加了2倍[3]。' },
    { heading: '接下来看什么', text: '作者指出，这一结论只来自一条俯冲带，还需要更长的观测序列检验[4]。' },
  ],
  why: '',
  refs: [
    ref({ venue: 'Synthetic Geoscience Letters', title: 'Accelerating slow slip before a synthetic megathrust event', uri: 'https://doi.org/10.5555/synthetic.0100', scope: 'abstract' }),
    ref({ source: 'synthetic-preprints', venue: 'Synthetic Preprints', title: 'Repeating earthquakes and slow slip', uri: 'https://papers.synthetic-preprints.org/abs/2610.00100', review: 'preprint', scope: 'full_text' }),
    ref({ source: 'synthetic-lab-blog', venue: 'Synthetic Lab Blog', title: 'What slow slip can and cannot tell us', uri: 'https://blog.synthetic-lab.org/posts/slow-slip', review: 'institution', scope: 'full_text' }),
  ],
});

// ---- golden renders -----------------------------------------------------------------------------------------------------------

describe('golden renders', () => {
  it('the weekday brief: two sections, 还有, source lines, votes and the footer', async () => {
    const rendered = await renderEmail(input({ items: WEEKDAY_ITEMS, more: WEEKDAY_MORE, costUsd: 0.8234 }));
    expect(rendered.subject).toBe('简报 · 10月12日（周一）');
    golden('email-weekday.html', rendered.html);
    golden('email-weekday.txt', rendered.text);
  });

  it('the Saturday deep read: its headings, its sources at the end, a writer after a fallback', async () => {
    const rendered = await renderEmail(input({ date: '2026-10-17', items: [DEEP_ITEM], costUsd: 1.0571, writers: ['claude-opus-5-5', 'claude-opus-5'], now: Date.parse('2026-10-17T14:30:00Z') }));
    expect(rendered.subject).toBe('深读 · 10月17日：慢滑移如何为大地震蓄力');
    golden('email-deep.html', rendered.html);
    golden('email-deep.txt', rendered.text);
  });

  it('a quiet day: the title and the reason, through the same ledger', async () => {
    const rendered = await renderEmail(input({ date: '2026-10-13', quiet: 'not_scored', shadow: true }));
    expect(rendered.subject).toBe('[影子版] 简报 · 10月13日：今日无条目');
    golden('email-quiet.html', rendered.html);
    golden('email-quiet.txt', rendered.text);
  });
});

// ---- what every render keeps --------------------------------------------------------------------------------------------------

function bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

function bodyOf(html: string): string {
  return html.slice(html.indexOf('<body'));
}

describe('every render', () => {
  it('ends each item with 👍 · 👎 · 多来点, links that verify for this issue, item and vote, in both parts', async () => {
    const rendered = await renderEmail(input({ items: WEEKDAY_ITEMS, more: WEEKDAY_MORE }));
    const key = await feedbackKey(KEY);
    if (key === null) throw new Error('no key');
    const tokens = [...rendered.html.matchAll(/href="https:\/\/brief\.example\.org\/feedback\?t=([^"]+)"/g)].map((match) => decodeURIComponent(match[1] ?? ''));
    const claims = await Promise.all(tokens.map((token) => verifyFeedback(key, token, NOW)));
    expect(claims).toEqual(WEEKDAY_ITEMS.flatMap((entry) => VOTES.map((vote) => ({ issue: '2026-10-12', item: entry.id, vote }))));
    for (const token of tokens) expect(rendered.text).toContain(`https://${HOST}/feedback?t=${token}`);
    const unsigned = await renderEmail(input({ items: WEEKDAY_ITEMS, feedbackKeyHex: '' }));
    expect(unsigned.html).not.toContain('/feedback');
    expect(unsigned.text).not.toContain('/feedback');
  });

  it('has the same words in both parts: titles, paragraphs, why and the source lines, markers dropped', async () => {
    const rendered = await renderEmail(input({ items: WEEKDAY_ITEMS, more: WEEKDAY_MORE }));
    for (const entry of WEEKDAY_ITEMS) {
      const lines = [...typeset(entry.title), ...entry.paragraphs.flatMap((paragraph) => typeset(paragraph.text)), `为什么看：${typeset(entry.why).join(' ')}`, sourceLine(entry).text];
      for (const line of lines) {
        expect(rendered.html).toContain(escapeHtml(line));
        expect(rendered.text).toContain(line);
      }
    }
    expect(rendered.html).not.toMatch(/\[\d/);
    expect(rendered.text).not.toMatch(/\[\d/);
  });

  it('is Gmail-safe and loads nothing: inline styles, https links only, no image, script, font or custom property', async () => {
    for (const rendered of [await renderEmail(input({ items: WEEKDAY_ITEMS, more: WEEKDAY_MORE })), await renderEmail(input({ date: '2026-10-17', items: [DEEP_ITEM] })), await renderEmail(input({ quiet: 'budget_spent' }))]) {
      expect(rendered.html).not.toMatch(/<img|<script|<link|<iframe|<form|<video|src=|url\(|@import|@font-face|var\(--|position:/i);
      expect([...rendered.html.matchAll(/href="([^"]+)"/g)].every((match) => (match[1] ?? '').startsWith('https://'))).toBe(true);
      // The page colour is on a table (Gmail drops <body>), the panel at most 600 px with the CJK font stack.
      expect(rendered.html).toMatch(/<table role="presentation" class="bg"[^>]*style="background-color:#f2f2f5;"/);
      expect(rendered.html).toMatch(/style="max-width:600px;"/);
      expect(rendered.html).toMatch(/class="panel" lang="zh-CN" style="[^"]*font-family:[^"]*'PingFang SC'[^"]*'Noto Sans SC'[^"]*font-size:17px;line-height:1\.75;/);
      // Mid-tone colours that survive Gmail's forced inversion: no pure black anywhere.
      expect(rendered.html).not.toMatch(/#000\b|#000000|:black/i);
    }
  });

  it('gives every coloured element a class the dark scheme restyles', async () => {
    const rendered = await renderEmail(input({ items: WEEKDAY_ITEMS, more: WEEKDAY_MORE }));
    const dark = /@media \(prefers-color-scheme:dark\)\{(.*)\}<\/style>/.exec(rendered.html)?.[1] ?? '';
    const classes = new Set([...bodyOf(rendered.html).matchAll(/class="([^"]+)"/g)].flatMap((match) => (match[1] ?? '').split(' ')));
    expect([...classes].sort()).toEqual(['a', 'bg', 'm', 'panel', 'pill', 'rule']);
    for (const name of classes) expect(dark, name).toContain(`.${name}{`);
    expect(rendered.html).toContain('<meta name="color-scheme" content="light dark">');
    // Every element with an inline colour has a class (an unclassed colour would stay light in the dark).
    const coloured = bodyOf(rendered.html).match(/<[a-z0-9]+\b[^>]*style="[^"]*#[0-9a-f]{3,6}\b[^"]*"[^>]*>/gi) ?? [];
    expect(coloured.length).toBeGreaterThan(10);
    for (const tag of coloured) expect(tag, tag).toMatch(/class="/);
  });

  it('stays under EMAIL_HTML_MAX at the issue bounds: 11 long items, 5 long 还有 titles, 8 long sources', async () => {
    const long = (n: number): string => '长'.repeat(n);
    const refs = Array.from({ length: 3 }, (_, i) => ref({ venue: `Synthetic Venue With A Rather Long Name ${String(i)}`, uri: `https://journal.synthetic-geo.org/articles/${'x'.repeat(200)}${String(i)}` }));
    const many = Array.from({ length: 11 }, (_, i) =>
      item({ id: i < 8 ? `r${String(i + 1)}` : `w${String(i - 7)}`, section: i < 8 ? 'research' : 'world', title: long(80), why: long(200), refs, paragraphs: [{ heading: '', text: `${long(250)}[1]。` }, { heading: '', text: `${long(250)}[2]。` }] }),
    );
    const more = Array.from({ length: 5 }, (_, i) => ({ source: 's', title: 'T'.repeat(300), venue: 'Synthetic Venue', review: 'peer_reviewed' as const, uri: `https://doi.org/10.5555/synthetic.${String(i)}` }));
    const weekday = await renderEmail(input({ items: many, more, writers: ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8'], costUsd: 1.99 }));
    expect(bytes(weekday.html)).toBeLessThan(EMAIL_HTML_MAX);
    const sources = Array.from({ length: 8 }, (_, i) => ref({ title: 'T'.repeat(300), uri: `https://doi.org/10.5555/synthetic.${String(i)}` }));
    const deep = await renderEmail(input({ date: '2026-10-17', items: [item({ ...DEEP_ITEM, refs: sources, paragraphs: Array.from({ length: 10 }, (_, i) => ({ heading: i % 3 === 0 ? long(20) : '', text: `${long(300)}[1]。` })) })] }));
    expect(bytes(deep.html)).toBeLessThan(EMAIL_HTML_MAX);
  });

  it('escapes what the model and the feeds wrote', async () => {
    const rendered = await renderEmail(
      input({
        items: [item({ title: '<script>alert(1)</script>', paragraphs: [{ heading: '<b>', text: 'A & B <img src=x>[1]。' }], why: '"quoted"', refs: [ref({ venue: '<i>Venue</i>', uri: 'javascript:alert(1)' })] })],
        more: [{ source: 's', title: '<svg onload=x>', venue: 'V', review: 'news', uri: 'https://example.org/a"b' }],
      }),
    );
    expect(rendered.html).not.toMatch(/<script|<img|<svg|<b>|<i>|javascript:/);
    expect(rendered.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(rendered.html).toContain('A &amp; B &lt;img src=x&gt;');
    expect(rendered.html).toContain('为什么看：&quot;quoted&quot;');
    expect(rendered.html).toContain('href="https://example.org/a%22b"');
  });
});

describe('the words', () => {
  it('typesets the model text: a space between Han and Latin or digits, markers and doubled spaces dropped, lines split', () => {
    expect(typeset('GPT-5的推理成本降低30%以上[1]。')).toEqual(['GPT-5 的推理成本降低 30% 以上。']);
    expect(typeset('GPT-5 的推理成本降低 30% 以上 [1, 2]。')).toEqual(['GPT-5 的推理成本降低 30% 以上。']);
    expect(typeset('作者报告（Qwen3-235B）在H100上的结果[3]；')).toEqual(['作者报告（Qwen3-235B）在 H100 上的结果；']);
    expect(typeset('第一段。\n\n  第二段[2]。\n')).toEqual(['第一段。', '第二段。']);
    expect(typeset('  ')).toEqual([]);
  });

  it('writes the source line from the registry and the fetch, never the model', () => {
    const paper = ref({ venue: 'Synthetic Preprints', review: 'preprint', scope: 'abstract', uri: 'https://papers.synthetic-preprints.org/abs/1' });
    const blog = ref({ venue: 'Synthetic Lab Blog', review: 'institution', scope: 'full_text' });
    // A research item is its paper: a blog read in full does not lift 仅摘要.
    expect(sourceLine(item({ refs: [paper, blog] }))).toEqual({ text: 'Synthetic Preprints、Synthetic Lab Blog · 预印本（未经同行评议） · 仅摘要', uri: 'https://papers.synthetic-preprints.org/abs/1' });
    expect(sourceLine(item({ refs: [{ ...paper, scope: 'full_text' }, blog] })).text).toBe('Synthetic Preprints、Synthetic Lab Blog · 预印本（未经同行评议）');
    // A world story was read in full when any article was.
    const summary = ref({ venue: 'Synthetic Daily', review: 'news', scope: 'feed_summary' });
    expect(sourceLine(item({ section: 'world', refs: [summary, { ...summary, venue: 'Synthetic Wire', scope: 'full_text' }] })).text).toBe('Synthetic Daily、Synthetic Wire · 新闻报道');
    expect(sourceLine(item({ section: 'world', refs: [summary] })).text).toBe('Synthetic Daily · 新闻报道 · 仅摘要');
    // At most three venues, each once; only https links.
    const venues = ['A', 'B', 'A', 'C', 'D'].map((venue) => ref({ venue, scope: 'full_text', uri: 'http://insecure.example.org/x' }));
    expect(sourceLine(item({ refs: venues }))).toEqual({ text: 'A、B、C · 同行评议', uri: null });
    for (const review of REVIEWS) expect(sourceLine(item({ refs: [ref({ review, scope: 'full_text' })] })).text).toBe(`Synthetic Journal of Seismology · ${REVIEW_WORDS[review]}`);
  });

  it('names the writer after a fallback in the footer', async () => {
    expect(modelName('claude-opus-5-5')).toBe('Claude Opus 5.5');
    expect(modelName('claude-opus-4-8')).toBe('Claude Opus 4.8');
    expect(modelName('claude-opus-5-20260601')).toBe('Claude Opus 5');
    expect(modelName('something-else')).toBe('something-else');
    const footer = async (writers: string[]): Promise<string> => (await renderEmail(input({ items: [item()], writers }))).text.trim().split('\n').at(-1) ?? '';
    expect(await footer(['claude-opus-5-5'])).toBe('1 条 · 本期 $0.00');
    expect(await footer([])).toBe('1 条 · 本期 $0.00');
    expect(await footer(['claude-opus-5-5', 'claude-opus-5'])).toBe('1 条 · 本期 $0.00 · 部分由 Claude Opus 5 撰写');
    expect(await footer(['claude-opus-4-8'])).toBe('1 条 · 本期 $0.00 · 由 Claude Opus 4.8 撰写');
  });

  it('says every quiet reason in words, with the cost only when something was spent', async () => {
    for (const [reason, words] of Object.entries(QUIET_WORDS) as [QuietReasonName, string][]) {
      const weekday = await renderEmail(input({ quiet: reason }));
      expect(weekday.text.split('\n').slice(0, 3)).toEqual(['简报 · 10月12日：今日无条目', '', `原因：${words}。`]);
      expect(weekday.html).not.toMatch(/研究前沿|世界与经济|\/feedback/);
    }
    const saturday = await renderEmail(input({ date: '2026-10-17', quiet: 'no_readable_thread', costUsd: 0.31 }));
    expect(saturday.subject).toBe('深读 · 10月17日：本周无深读');
    expect(saturday.text).toBe(`深读 · 10月17日：本周无深读\n\n原因：没有可读全文的线索。\n\n网页版：https://${HOST}/issues/2026-10-17\n本期 $0.31\n`);
    expect((await renderEmail(input({ quiet: 'no_candidates', costUsd: 0.004 }))).text).not.toContain('本期');
  });
});
