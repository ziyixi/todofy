/**
 * A Saturday in workerd (design §9, §17): the week's cards, the deep-read pick, the thread's full texts (an arXiv HTML
 * version with MathML read as its alt text), the deep read, its check, the render with its sources and the send at
 * 07:30. Friday's issue, created after its send cutoff, ends with its note, archived (issue_missed), without a model
 * call.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { la, startHarness, type Harness } from './harness.ts';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
  await h.runUntil(la('2026-10-16', '12:30'), la('2026-10-17', '09:00'));
}, 120_000);

afterAll(async () => {
  await h.dispose();
});

describe('a Saturday', () => {
  it('writes the deep read from a thread with readable full texts and sends it at 07:30', async () => {
    const [saturday] = await h.sql<{ state: string; title: string; kind: string; item_count: number; send_ms: number }>(`SELECT * FROM issues WHERE issue = '2026-10-17'`);
    expect(saturday).toMatchObject({ state: 'sent', kind: 'deep_read', title: '深读 · 10月17日：断层如何慢慢滑动', item_count: 1 });
    expect(saturday?.send_ms).toBeGreaterThanOrEqual(la('2026-10-17', '07:30'));
    const deepMail = h.sent.find((mail) => mail.key === 'brief-2026-10-17');
    expect(deepMail?.body.subject).toBe('深读 · 10月17日：断层如何慢慢滑动');
    expect(deepMail?.body.html).toContain('来源');
    expect(deepMail?.body.html).toContain('接下来看什么');
    expect(h.claude.steps()).toEqual(expect.arrayContaining(['deep_pick', 'deep_read']));
    const deepRead = h.claude.requests.find((request) => request.step === 'deep_read')?.body ?? {};
    expect(deepRead['output_config']).toMatchObject({ effort: 'high' });
    const [item] = await h.sql<{ id: string; section: string; citations: string }>(`SELECT * FROM issue_items WHERE issue = '2026-10-17'`);
    expect(item).toMatchObject({ id: 'deep', section: 'deep_read' });
  });

  it('read MathML as its alt text and dropped scripts, navigation and footers', async () => {
    const texts = await h.sql<{ uri: string; scope: string; text: string }>(`SELECT uri, scope, text FROM texts WHERE issue = '2026-10-17'`);
    expect(texts.filter((text) => text.scope === 'full_text').length).toBeGreaterThanOrEqual(2);
    const arxiv = texts.find((text) => text.uri.startsWith('https://arxiv.org/html/') && text.scope === 'full_text');
    expect(arxiv?.text).toContain('L = \\sum_i (u_i - d_i)^2');
    expect(arxiv?.text).not.toContain('garbled');
    // A paper without an HTML version (404) falls back to its abstract.
    const fallback = texts.find((text) => text.uri.startsWith('https://arxiv.org/html/') && text.uri.endsWith('01'));
    if (fallback !== undefined) expect(fallback.scope).toBe('abstract');
    for (const text of texts) {
      expect(text.text).not.toContain('tracker');
      expect(text.text).not.toContain('Copyright synthetic publisher');
    }
  });

  it('ended Friday issue, created after its send cutoff, without a model call, sending only Saturday', async () => {
    const [friday] = await h.sql<{ state: string }>(`SELECT state FROM issues WHERE issue = '2026-10-16'`);
    expect(friday?.state).toBe('archived');
    expect(await h.sql(`SELECT step FROM calls WHERE issue = '2026-10-16' AND step != 'gate'`)).toEqual([]);
    expect(h.sent.map((mail) => mail.key)).toEqual(['brief-2026-10-17']);
  });
});
