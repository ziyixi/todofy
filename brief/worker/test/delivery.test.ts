/**
 * The render, the ledger, the feedback token and the learning (design §10-§12): synthetic items only.
 */
import { describe, expect, it } from 'vitest';
import { signFeedback, verifyFeedback, feedbackKey } from '../src/feedback.ts';
import { learn, resetProfile, weightOf } from '../src/learn.ts';
import { bundled } from '../src/registry.ts';
import { issueTitle, renderEmail, renderHash, sourceLine, subjectOf, type FinalItem } from '../src/render.ts';
import { classify, sendOnce, settleSubmitting } from '../src/send.ts';
import { Store } from '../src/store.ts';
import { memorySql } from './fakes/sql.ts';

const NOW = Date.parse('2026-10-12T13:30:00Z');
const KEY = 'ab'.repeat(32);

function item(overrides: Partial<FinalItem> = {}): FinalItem {
  return {
    id: 'r1',
    section: 'research',
    topic: 'geo.seismology',
    format: 'professional',
    title: '新的上地幔层析模型 <script>',
    paragraphs: [{ heading: '', text: '研究团队提出新的上地幔层析成像模型，能分辨 410 公里深处的低速异常[1]。' }],
    why: '可作为上地幔低速结构的新约束。',
    refs: [{ source: 'gji', venue: 'Geophysical Journal International', title: 'A synthetic model', uri: 'https://doi.org/10.1093/gji/synthetic', review: 'peer_reviewed', scope: 'abstract', published: null }],
    citations: [{ n: 1, ref: 0, quote: 'The model resolves low-velocity anomalies down to 410 km depth', verdict: '' }],
    reason: '新数据揭示了以前看不到的结构',
    score: 8.5,
    keys: ['doi:10.1093/gji/synthetic'],
    sources: ['gji'],
    ...overrides,
  };
}

describe('the email', () => {
  it('names the day and the deep read, and tags the shadow week', () => {
    expect(issueTitle('2026-10-12', null, null)).toBe('简报 · 10月12日（周一）');
    expect(issueTitle('2026-10-12', null, 'no_candidates')).toBe('简报 · 10月12日：今日无条目');
    expect(issueTitle('2026-10-17', '慢滑移与地震', null)).toBe('深读 · 10月17日：慢滑移与地震');
    expect(issueTitle('2026-10-17', null, 'no_readable_thread')).toBe('深读 · 10月17日：本周无深读');
    expect(subjectOf('简报 · 10月12日（周一）', true)).toBe('[影子版] 简报 · 10月12日（周一）');
  });

  it('renders items without markers, escaped, with the source line, votes, 还有 and the footer; no remote resource', async () => {
    const rendered = await renderEmail({
      date: '2026-10-12',
      shadow: true,
      items: [item(), item({ id: 'w1', section: 'world', topic: 'world.economy', format: 'world_short', title: '央行决定', refs: [{ source: 'bbc-world', venue: 'BBC', title: 't', uri: 'https://www.bbc.co.uk/news/x', review: 'news', scope: 'full_text', published: null }] })],
      more: [{ source: 'seismica', title: 'Another synthetic paper', venue: 'Seismica', review: 'peer_reviewed', uri: 'https://seismica.library.mcgill.ca/x' }],
      costUsd: 0.8234,
      writers: ['claude-opus-5-5', 'claude-opus-5'],
      publicHost: 'brief.example.org',
      feedbackKeyHex: KEY,
      now: NOW,
      quiet: null,
    });
    expect(rendered.subject).toBe('[影子版] 简报 · 10月12日（周一）');
    expect(rendered.html).not.toContain('[1]');
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
    expect(rendered.html).toContain('Geophysical Journal International · 同行评议 · 仅摘要');
    expect(rendered.html).toContain('还有');
    expect(rendered.html).toContain('本期 $0.82');
    expect(rendered.html).toContain('部分由 Claude Opus 5 撰写');
    expect(rendered.html).toContain('prefers-color-scheme:dark');
    expect(rendered.html).toContain('https://brief.example.org/feedback?t=');
    expect(rendered.html.length).toBeLessThan(60 * 1024);
    expect(rendered.html).not.toMatch(/<img|<script|src=|url\(/i);
    expect(rendered.html.match(/href="([^"]+)"/g)?.every((href) => href.startsWith('href="https://'))).toBe(true);
    expect(rendered.text).toContain('研究团队提出新的上地幔层析成像模型');
    expect(rendered.text).not.toContain('[1]');
    expect(await renderHash(rendered)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('says a quiet day in two lines', async () => {
    const note = await renderEmail({ date: '2026-10-12', shadow: false, items: [], more: [], costUsd: 0, writers: [], publicHost: 'brief.example.org', feedbackKeyHex: '', now: NOW, quiet: 'not_scored' });
    expect(note.subject).toBe('简报 · 10月12日：今日无条目');
    expect(note.text).toContain('候选未能打分');
  });

  it('writes the source line from the registry, never the model', () => {
    expect(sourceLine(item()).text).toBe('Geophysical Journal International · 同行评议 · 仅摘要');
    const [ref] = item().refs;
    if (ref === undefined) throw new Error('no reference');
    expect(sourceLine(item({ refs: [{ ...ref, review: 'preprint', venue: 'arXiv', scope: 'full_text' }] })).text).toBe('arXiv · 预印本（未经同行评议）');
  });
});

describe('the delivery ledger', () => {
  it('maps every status class', () => {
    expect(classify(200, { id: 'msg-1' })).toEqual({ outcome: 'accepted', messageId: 'msg-1' });
    expect(classify(200, {})).toEqual({ outcome: 'unknown', messageId: '' });
    expect(classify(422, null).outcome).toBe('rejected');
    expect(classify(403, null).outcome).toBe('rejected');
    for (const status of [0, 302, 408, 409, 429, 500, 503]) expect(classify(status, null).outcome).toBe('unknown');
  });

  function ledger(): Store {
    const store = new Store(memorySql());
    store.migrate();
    store.insert('issues', { issue: '2026-10-12', kind: 'weekday', state: 'ready', title: 't', created_ms: NOW });
    return store;
  }
  const email = { issue: '2026-10-12', subject: 's', html: '<p>h</p>', text: 't', hash: 'h'.repeat(64) };
  const mail = { key: 're_synthetic', from: 'Brief <brief@example.com>', to: 'owner@example.com' };

  it('reserves first, sends once with the idempotency key, and never again', async () => {
    const store = ledger();
    const requests: Request[] = [];
    const fetchFn = (request: Request): Promise<Response> => {
      requests.push(request);
      return Promise.resolve(Response.json({ id: 'msg-synthetic' }));
    };
    const first = await sendOnce(store, (fn) => fn(), fetchFn, mail, email, () => NOW);
    expect(first).toMatchObject({ outcome: 'accepted', fresh: true });
    expect(requests[0]?.headers.get('idempotency-key')).toBe('brief-2026-10-12');
    expect(requests[0]?.redirect).toBe('manual');
    const second = await sendOnce(store, (fn) => fn(), fetchFn, mail, email, () => NOW);
    expect(second).toMatchObject({ outcome: 'accepted', fresh: false });
    expect(requests).toHaveLength(1);
    expect(store.one<{ state: string }>(`SELECT state FROM issues`)?.state).toBe('sent');
  });

  it('an unknown outcome is never sent again, a submitting row after a crash is unknown', async () => {
    const store = ledger();
    let count = 0;
    const failing = (): Promise<Response> => {
      count++;
      return Promise.reject(new Error('network'));
    };
    expect((await sendOnce(store, (fn) => fn(), failing, mail, email, () => NOW)).outcome).toBe('unknown');
    expect((await sendOnce(store, (fn) => fn(), failing, mail, email, () => NOW)).outcome).toBe('unknown');
    expect(count).toBe(1);
    const crashed = ledger();
    crashed.insert('sends', { issue: '2026-10-12', idempotency_key: 'brief-2026-10-12', render_hash: 'h', state: 'submitting', created_ms: NOW });
    expect(settleSubmitting(crashed, NOW)).toBe(1);
    expect(crashed.one<{ state: string }>(`SELECT state FROM sends`)?.state).toBe('unknown');
    expect(crashed.one<{ state: string }>(`SELECT state FROM issues`)?.state).toBe('send_unknown');
  });

  it('a 4xx refusal is recorded and not retried', async () => {
    const store = ledger();
    const result = await sendOnce(store, (fn) => fn(), () => Promise.resolve(Response.json({ message: 'synthetic' }, { status: 422 })), mail, email, () => NOW);
    expect(result.outcome).toBe('rejected');
    expect(store.one<{ state: string; error_code: string }>(`SELECT state, error_code FROM issues`)).toEqual({ state: 'send_rejected', error_code: 'resend_422' });
  });
});

describe('the feedback token', () => {
  it('signs, verifies, refuses tampering and expiry', async () => {
    const key = await feedbackKey(KEY);
    if (key === null) throw new Error('no key');
    const token = await signFeedback(key, { issue: '2026-10-12', item: 'r1', vote: 'up' }, NOW);
    expect(token.split('.')[1]).toHaveLength(22);
    expect(await verifyFeedback(key, token, NOW + 1000)).toEqual({ issue: '2026-10-12', item: 'r1', vote: 'up' });
    expect(await verifyFeedback(key, token, NOW + 31 * 86_400_000)).toBeNull();
    const [payload, mac] = token.split('.');
    const forged = `${btoa(JSON.stringify(['2026-10-12', 'r1', 'down', 9_999_999_999])).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.${mac ?? ''}`;
    expect(await verifyFeedback(key, forged, NOW)).toBeNull();
    expect(await verifyFeedback(key, `${payload ?? ''}.${'A'.repeat(22)}`, NOW)).toBeNull();
    const other = await feedbackKey('cd'.repeat(32));
    if (other === null) throw new Error('no key');
    expect(await verifyFeedback(other, token, NOW)).toBeNull();
    expect(await verifyFeedback(key, 'x'.repeat(500), NOW)).toBeNull();
    expect(await feedbackKey('short')).toBeNull();
  });
});

describe('the weekly learning', () => {
  it('moves weights a little with few votes, within 0.6 and 1.4, and resets', () => {
    expect(weightOf({ shown: 0, up: 0, down: 0, more: 0 })).toBe(1);
    expect(weightOf({ shown: 5, up: 3, down: 0, more: 0 })).toBeCloseTo(1.2, 6);
    expect(weightOf({ shown: 2, up: 0, down: 10, more: 0 })).toBe(0.6);
    expect(weightOf({ shown: 2, up: 0, down: 0, more: 30 })).toBe(1.4);
    const store = new Store(memorySql());
    store.migrate();
    const { registry, topics } = bundled();
    for (let i = 1; i <= 4; i++) {
      store.insert('issue_items', { issue: '2026-10-0' + String(i + 4), id: 'r1', position: 0, section: 'research', topic: 'geo.seismology', format: 'professional', title: 't', paragraphs: '[]', refs: '[]', citations: '[]', keys: '[]', sources: JSON.stringify(['gji']) });
      store.insert('votes', { issue: '2026-10-0' + String(i + 4), item: 'r1', origin: 'owner', vote: i === 4 ? 'more' : 'up', ms: NOW - i * 86_400_000 });
    }
    learn(store, registry, topics, NOW);
    const weight = (kind: string, id: string) => store.one<{ weight: number }>(`SELECT weight FROM weights WHERE kind = ? AND id = ?`, kind, id)?.weight;
    expect(weight('topic', 'geo.seismology')).toBeCloseTo(1 + 5 / 14, 6);
    expect(weight('source', 'gji')).toBeCloseTo(1 + 5 / 14, 6);
    expect(weight('topic', 'llm.agents')).toBe(1);
    resetProfile(store, NOW);
    learn(store, registry, topics, NOW + 1000);
    expect(weight('topic', 'geo.seismology')).toBe(1);
  });
});
