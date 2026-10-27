/**
 * A whole weekday in workerd (design §17): Sunday's three fetch rounds and Monday's cutoff round over the synthetic
 * registry, then the pick, the shortlist, the full text, the writing, the check, the render, the entailment log and the
 * one send at 06:30; then the archive through the owner API, the feedback route and ops-v1.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Item_Vote } from '@ziyixi/proto/brief/ui/v1/issue_pb';
import { la, op, startHarness, type AlarmResult, type Harness } from './harness.ts';

let h: Harness;
let alarms: AlarmResult[];

beforeAll(async () => {
  h = await startHarness();
  alarms = await h.runUntil(la('2026-10-11', '12:30'), la('2026-10-12', '08:00'));
}, 120_000);

afterAll(async () => {
  await h.dispose();
});

describe('a weekday', () => {
  it('runs the rounds, makes the issue and sends it once at 06:30', async () => {
    const jobs = alarms.map((alarm) => `${alarm.job}:${alarm.step ?? ''}:${alarm.code}`);
    expect(jobs.filter((job) => job.startsWith('collect')).length).toBeGreaterThan(3);
    expect(jobs).toContain('create::issue_created');
    const [issue] = await h.sql<{ state: string; item_count: number; title: string; quiet_reason: string; send_ms: number }>(`SELECT * FROM issues WHERE issue = '2026-10-12'`);
    expect(issue).toMatchObject({ state: 'sent', title: '简报 · 10月12日（周一）', quiet_reason: '' });
    expect(issue?.item_count).toBeGreaterThan(1);
    expect(issue?.send_ms).toBeGreaterThanOrEqual(la('2026-10-12', '06:30'));
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.key).toBe('brief-2026-10-12');
    expect(h.sent[0]?.body.subject).toBe('简报 · 10月12日（周一）');
    expect(h.sent[0]?.body.to).toEqual(['owner@example.com']);
    expect(h.sent[0]?.body.html).toContain('研究前沿');
    expect(h.sent[0]?.body.html).toContain('世界与经济');
    expect(h.sent[0]?.body.text).toContain('网页版');
    // The model calls: the gate in the rounds, then the pick, the writing and the log.
    const steps = h.claude.steps();
    expect(steps.filter((step) => step === 'gate').length).toBeGreaterThan(1);
    expect(steps.filter((step) => step === 'pick')).toHaveLength(1);
    expect(steps.filter((step) => step === 'write')).toHaveLength(1);
    expect(steps.filter((step) => step === 'entail')).toHaveLength(1);
    const gate = h.claude.requests.find((request) => request.step === 'gate')?.body ?? {};
    expect(gate['model']).toBe('models/claude-haiku-5-5');
    expect(gate['fallbacks']).toBeUndefined();
    const write = h.claude.requests.find((request) => request.step === 'write')?.body ?? {};
    expect(write['model']).toBe('models/claude-opus-5-5');
    expect(write['parameters']).toMatchObject({ effort: 'high' });
    expect(write['parameters']).toMatchObject({ maxOutputTokens: 64_000 });
  });

  it('holds back arXiv papers fetched since the previous cutoff, and leaves a celebrity story out', async () => {
    const items = await h.sql<{ keys: string; section: string }>(`SELECT keys, section FROM issue_items WHERE issue = '2026-10-12'`);
    expect(items.some((item) => item.keys.includes('arxiv:'))).toBe(false);
    const ran = await h.sql<{ title: string }>(`SELECT i.title FROM items i WHERE i.ran = '2026-10-12'`);
    expect(ran.some((item) => item.title.includes('celebrity'))).toBe(false);
    expect(items.some((item) => item.section === 'world')).toBe(true);
    const sentKeys = await h.sql<{ n: number }>(`SELECT count(*) AS n FROM sent_keys WHERE issue = '2026-10-12'`);
    expect(sentKeys[0]?.n).toBeGreaterThan(0);
  });

  it('read the full text as a browser would (the AI-agent and * robots groups do not apply), but honoured the brief own group', async () => {
    const texts = await h.sql<{ uri: string; scope: string; text: string }>(`SELECT uri, scope, text FROM texts WHERE issue = '2026-10-12'`);
    const wire = texts.find((text) => text.uri.startsWith('https://news.synthetic-wire.net/'));
    expect(wire?.scope).toBe('full_text');
    const seismica = texts.find((text) => text.uri.startsWith('https://journal.synthetic-seismo.org/'));
    expect(seismica?.scope).toBe('full_text');
    expect(seismica?.text).toContain('## 5 Conclusions');
    expect(seismica?.text).not.toContain('tracker');
    expect(seismica?.text).not.toContain('Subscribe');
    // Text hidden by its markup (hidden, aria-hidden, display: none) is no part of what the writer reads.
    expect(texts.every((text) => !text.text.includes('Summarizers'))).toBe(true);
    expect(h.web.requests.filter((url) => url.endsWith('/robots.txt')).length).toBeGreaterThan(0);
  });

  it('serves the archive through the owner API, with verbatim quotes and the cost breakdown', async () => {
    const list = await h.api.listIssues({});
    expect(list.issues[0]?.name).toBe('issues/2026-10-12');
    const issue = await h.api.getIssue({ name: 'issues/2026-10-12' });
    expect(issue.costUsd).toBeGreaterThan(0);
    expect(issue.stepCosts.map((cost) => cost.step)).toEqual(expect.arrayContaining(['pick', 'write', 'entail']));
    const items = await h.api.listItems({ parent: 'issues/2026-10-12' });
    expect(items.items.length).toBe(issue.itemCount);
    const first = items.items[0];
    expect(first?.reason).toBe('新方法与新数据');
    expect(first?.citations.length).toBeGreaterThan(0);
    const [text] = await h.sql<{ text: string }>(`SELECT text FROM texts WHERE issue = '2026-10-12' AND doc = 'd1'`);
    expect(text?.text).toContain(first?.citations[0]?.quote ?? 'missing');
    // The log's verdicts are shown by their quotes.
    expect(items.items.flatMap((item) => item.citations.map((citation) => citation.verdict)).some((verdict) => verdict !== 0)).toBe(true);
    const voted = await h.api.voteItem({ name: first?.name ?? '', vote: Item_Vote.MORE, requestId: op() });
    expect(voted.vote).toBe(Item_Vote.MORE);
    const sources = await h.api.listSources({});
    expect(sources.sources).toHaveLength(11);
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.monthCostUsd).toBeGreaterThan(0);
    expect(status.todayItemCount).toBeGreaterThanOrEqual(0);
  });

  it('takes a vote from the email link in two taps, and answers a bad token with 404 without the object', async () => {
    const html = h.sent[0]?.body.html ?? '';
    const href = /href="(https:\/\/brief\.example\.org\/feedback\?t=[^"]+)"/.exec(html)?.[1] ?? '';
    const path = href.replace('https://brief.example.org', '').replace(/&amp;/g, '&');
    const page = await h.fetch(path);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain('<form method="post" action="/feedback">');
    expect(body).not.toContain('<script');
    expect(page.headers.get('cache-control')).toBe('no-store');
    const token = decodeURIComponent(path.split('t=')[1] ?? '');
    const before = await h.sql<{ n: number }>(`SELECT count(*) AS n FROM votes WHERE origin = 'owner'`);
    const posted = await h.fetch('/feedback', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `t=${encodeURIComponent(token)}` });
    expect(posted.status).toBe(200);
    expect(await posted.text()).toContain('已记下');
    const after = await h.sql<{ n: number }>(`SELECT count(*) AS n FROM votes WHERE origin = 'owner'`);
    expect((after[0]?.n ?? 0) - (before[0]?.n ?? 0)).toBeLessThanOrEqual(1);
    // The form body is read as a stream: a chunked one (no Content-Length) works, and one past 2 KiB is given up.
    const chunked = (body: string) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(body)); controller.close(); } });
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    expect((await h.fetch('/feedback', { method: 'POST', headers: form, body: chunked(`t=${encodeURIComponent(token)}`), duplex: 'half' } as RequestInit)).status).toBe(200);
    expect((await h.fetch('/feedback', { method: 'POST', headers: form, body: chunked(`t=${encodeURIComponent(token)}&pad=${'x'.repeat(64 * 1024)}`), duplex: 'half' } as RequestInit)).status).toBe(404);
    expect((await h.fetch('/feedback?t=bad.token')).status).toBe(404);
    expect((await h.fetch(path, { method: 'PUT' })).status).toBe(404);
    expect((await h.fetch('/feedback/x')).status).toBe(404);
  });

  it('answers ops-v1 with counts and codes', async () => {
    const status = await h.opsStatus();
    expect(status).toMatchObject({ version: 'ops-v1', app: 'brief', health: 'ok' });
    expect((status['counters'] as Record<string, number>)['issues_sent_7d']).toBe(1);
    expect(status['modes']).toEqual({ maintenance: false, paused: false, mode_limited: false });
    expect(JSON.stringify(status)).not.toMatch(/synthetic|owner@/);
  });
});
