/**
 * The end-to-end dry run (design §16, §17): one shadow-week weekday from the feeds to the inbox, in workerd with a real
 * BriefState and nothing but fakes outside it. The synthetic feeds and pages are polled in Sunday's rounds and Monday's
 * cutoff round; Haiku screens them; Opus picks across topics and writes plausible Chinese items with verbatim quotes and
 * the quotes' numbers (test/fakes/plausible.ts), one of them overstated; the check sends that item to one repair; the
 * render, the entailment log and the one send through the fake Resend at 06:30 follow. Then the day runs on, an alarm
 * runs twice, and still exactly one email went out.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { plausibleClaude, plausiblePages } from '../fakes/plausible.ts';
import { la, startHarness, type AlarmResult, type Harness } from './harness.ts';

const CONFIG = join(dirname(fileURLToPath(import.meta.url)), '../../../content-config');
const ISSUE = '2026-10-12';

let h: Harness;
let alarms: AlarmResult[];

beforeAll(async () => {
  h = await startHarness({ bindings: { MODE: 'shadow' } });
  plausiblePages(h.web, la('2026-10-11', '00:00'));
  h.claude.script = plausibleClaude();
  alarms = await h.runUntil(la('2026-10-11', '12:30'), la('2026-10-12', '23:59'));
}, 120_000);

afterAll(async () => {
  await h.dispose();
});

interface ItemRow {
  id: string;
  position: number;
  section: string;
  topic: string;
  format: string;
  title: string;
  paragraphs: string;
  why: string;
  citations: string;
  refs: string;
  reason: string;
}

function items(): Promise<ItemRow[]> {
  return h.sql<ItemRow>(`SELECT * FROM issue_items WHERE issue = ? ORDER BY position`, ISSUE);
}

describe('the dry run of a shadow weekday', () => {
  it('screens, picks, writes, repairs once and checks, with the requests design §5-§8 describe', async () => {
    const steps = h.claude.steps();
    expect(steps.filter((step) => step === 'gate').length).toBeGreaterThan(1);
    expect(steps.filter((step) => step !== 'gate')).toEqual(['pick', 'write', 'repair', 'entail']);
    const [policy, profile] = await Promise.all([readFile(join(CONFIG, 'policy.md'), 'utf8'), readFile(join(CONFIG, 'profile.md'), 'utf8')]);
    for (const request of h.claude.requests) {
      const body = request.body;
      expect(body).not.toHaveProperty('stream');
      expect(typeof body['input']).toBe('string');
      for (const key of ['thinking', 'temperature', 'top_p', 'top_k']) expect(body).not.toHaveProperty(key);
      expect(JSON.parse(String(body['outputSchemaJson']))).toMatchObject({ type: 'object' });
      const opus = request.step !== 'gate' && request.step !== 'entail';
      expect(body['model']).toBe(opus ? 'claude-opus-5-5' : 'claude-haiku-5-5');
      expect(body['allowFallback']).toBe(opus);
      expect(body['effort']).toBe({ gate: 'low', entail: 'low', pick: 'medium' }[request.step as string] ?? 'high');
    }
    // The writer's frozen prefix, policy.md then profile.md, ends in the one breakpoint; its own rules follow uncached.
    for (const step of ['write', 'repair']) {
      const system = h.claude.requests.find((request) => request.step === step)?.body['instructions'] as { text: string; cache?: boolean }[];
      expect(system[0]).toEqual(expect.objectContaining({ text: `${policy.trim()}\n\n${profile.trim()}`, cache: true }));
      expect(system[1]?.cache).toBe(false);
    }
    // The repair got the overstated item with its code and the offending number.
    const repair = h.claude.requests.find((request) => request.step === 'repair')?.body['input'] ?? '';
    expect(repair).toContain('number_unsupported (paragraph 1): 3');
    const [run] = await h.sql<{ step: string; error_code: string }>(`SELECT step, error_code FROM runs WHERE issue = ?`, ISSUE);
    expect(run).toEqual({ step: 'done', error_code: '' });
    expect(alarms.some((alarm) => alarm.code === 'repaired')).toBe(true);
  });

  it('keeps every quote verbatim and every item in the pick order, the repaired first item first', async () => {
    const rows = await items();
    const [issue] = await h.sql<{ item_count: number; dropped_count: number; shadow: number; quiet_reason: string }>(`SELECT * FROM issues WHERE issue = ?`, ISSUE);
    expect(issue).toMatchObject({ item_count: rows.length, dropped_count: 0, shadow: 1, quiet_reason: '' });
    expect(rows.map((row) => `${row.section}:${row.topic}:${row.format}`)).toEqual([
      'research:geo.seismology:professional',
      'research:geo.seismology:professional',
      'research:llm.systems:familiar',
      'research:llm.systems:familiar',
      'world:world.economy:plain',
      'world:world.affairs:plain',
    ]);
    expect(rows.map((row) => row.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'w1', 'w2']);
    expect(new Set(rows.map((row) => row.title)).size).toBe(rows.length);
    expect(rows[0]?.paragraphs).not.toContain('3 倍');
    expect(rows.map((row) => row.reason)).toContain('多年来首次加息，影响面广');
    const texts = (await h.sql<{ text: string }>(`SELECT text FROM texts WHERE issue = ?`, ISSUE)).map((row) => row.text);
    for (const row of rows) {
      const citations = JSON.parse(row.citations) as { n: number; quote: string; verdict: string }[];
      expect(citations.length).toBeGreaterThanOrEqual(2);
      for (const citation of citations) {
        expect(texts.some((text) => text.includes(citation.quote))).toBe(true);
        expect(citation.verdict).toBe('supported');
      }
    }
    // A world story is its cluster's two best documents, readable full text first: the wire's articles of both days.
    const refs = JSON.parse(rows[4]?.refs ?? '[]') as { venue: string; scope: string }[];
    expect(refs.map((ref) => `${ref.venue}:${ref.scope}`)).toEqual(['Synthetic Wire:full_text', 'Synthetic Wire:full_text']);
  });

  it('sends exactly one email at 06:30, tagged for the shadow week, in the order and words of the archive', async () => {
    expect(h.sent).toHaveLength(1);
    const mail = h.sent[0];
    expect(mail?.key).toBe(`brief-${ISSUE}`);
    expect(mail?.body.subject).toBe('[影子版] 简报 · 10月12日（周一）');
    expect(mail?.body.to).toEqual(['owner@example.com']);
    const sends = await h.sql<{ issue: string; state: string; idempotency_key: string; created_ms: number }>(`SELECT * FROM sends`);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ issue: ISSUE, state: 'accepted', idempotency_key: `brief-${ISSUE}` });
    expect(sends[0]?.created_ms).toBeGreaterThanOrEqual(la(ISSUE, '06:30'));
    const html = mail?.body.html ?? '';
    const text = mail?.body.text ?? '';
    const rows = await items();
    // The titles in the archive's order, in both parts; no marker; the numbers as the quotes have them.
    const at = (part: string) => rows.map((row) => part.indexOf(row.title));
    for (const part of [html, text]) {
      expect(at(part).every((index) => index > 0)).toBe(true);
      expect(at(part)).toEqual([...at(part)].sort((a, b) => a - b));
      expect(part).not.toMatch(/\[\d+\]/);
      expect(part).not.toContain('3 倍');
    }
    expect(text).toContain('在 H100 上把中位延迟降低了 38%');
    expect(text).toContain('约 130 万人流离失所');
    expect(text).toContain('Seismica · 同行评议');
    expect(text).toContain('Synthetic Lab · 机构发布');
    expect(text).toContain('Synthetic Wire · 新闻报道');
    expect(text).toContain('还有');
    expect(text).toMatch(/网页版：https:\/\/brief\.example\.org\/issues\/2026-10-12\n6 条 · 本期 \$\d+\.\d\d$/m);
    // 👍 · 👎 · 多来点 under every item.
    expect(html.match(/href="https:\/\/brief\.example\.org\/feedback\?t=/g)).toHaveLength(3 * rows.length);
    // The footer's cost is the issue's calls up to the render (the pick, the write and the repair).
    const [cost] = await h.sql<{ usd: number }>(`SELECT sum(cost) AS usd FROM calls WHERE issue = ? AND step IN ('pick', 'write', 'repair')`, ISSUE);
    expect(text).toContain(`本期 $${(cost?.usd ?? 0).toFixed(2)}`);
  });

  it('never sends again: not in the rest of the day, not when an alarm runs twice', async () => {
    expect(alarms.filter((alarm) => alarm.code.startsWith('send_'))).toEqual([expect.objectContaining({ code: 'send_accepted' })]);
    expect(alarms.at(-1)?.next).toBeGreaterThan(la(ISSUE, '23:00'));
    await h.step(la(ISSUE, '23:59'));
    await h.step(la(ISSUE, '23:59'));
    expect(h.sent).toHaveLength(1);
    const [issue] = await h.sql<{ state: string }>(`SELECT state FROM issues WHERE issue = ?`, ISSUE);
    expect(issue?.state).toBe('sent');
    const ops = await h.opsStatus();
    expect((ops['counters'] as Record<string, number>)['issues_sent_7d']).toBe(1);
    expect(ops['modes']).toEqual({ maintenance: false, paused: false, mode_limited: true });
  });
});
