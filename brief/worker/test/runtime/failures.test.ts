/**
 * The failure paths in workerd (design §7, §12, §13, §15, §17): the refusal paths of the gate, the pick and the write
 * (bisection by packet); a request the Claude API refuses (anthropic_rejected, the note, 恢复调用); transient errors,
 * bounded by the send cutoff; a write out of tokens (halved), with answers that are no JSON, or with every packet left
 * out; a deploy that kills a step or a call (not counted) and a crash (counted, then given up); the emergency stops
 * during an issue (a pause, BRIEF_MODE=off and a redeploy); a host that backs off during the read; a gate call that
 * fails mid-stream; a story that ran and 还有 never repeated; the deep read out of tokens; an unknown send never sent
 * again; the month's budget; paused and archive modes; the owner API's settings rules.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ServiceStatus_KeyState } from '@ziyixi/proto/brief/ui/v1/status_pb';
import { modelError, jsonAnswer } from '../fakes/claude.ts';
import { la, op, reasonOf, rejection, SECOND, startHarness, type Harness, type HarnessOptions } from './harness.ts';

let h: Harness | null = null;

afterEach(async () => {
  await h?.dispose();
  h = null;
});

/** The packets of a write request (its user turn's JSON). */
function packetsIn(body: Record<string, unknown>): number {
  const content = (typeof body['input'] === 'string' ? body['input'] : '');
  return (content.match(/"packet":"p\d+"/g) ?? []).length;
}

/** Steps the run until its step is `step` (that step not yet run); answers the next alarm's time. */
async function untilStep(harness: Harness, from: number, step: string): Promise<number> {
  let at = from;
  for (let i = 0; i < 40; i++) {
    const [run] = await harness.sql<{ step: string }>(`SELECT step FROM runs WHERE issue = '2026-10-12'`);
    if (run?.step === step) return at;
    const result = await harness.step(at);
    at = Math.max(result.next, at + SECOND);
  }
  throw new Error(`never reached ${step}`);
}

/** Sunday's rounds and Monday's cutoff round, up to the creation of Monday's run (the next alarm is its first step). */
async function toMondayRun(options: HarnessOptions = {}): Promise<{ h: Harness; at: number }> {
  const harness = await startHarness(options);
  h = harness;
  let at = la('2026-10-11', '12:30');
  for (let i = 0; i < 200; i++) {
    const result = await harness.step(at);
    at = Math.max(result.next, at + SECOND);
    if (result.job === 'create') return { h: harness, at };
  }
  throw new Error('no run was created');
}

describe('refusals', () => {
  it('bisects a refused write by packet: the halves that answer make the issue, the refused packet is dropped', async () => {
    const { h, at } = await toMondayRun();
    h.claude.script = (body, step) => {
      if (step !== 'write') return null;
      const content = (typeof body['input'] === 'string' ? body['input'] : '');
      return content.includes('世界与经济') ? { finishReason: 'refused' } : null;
    };
    await h.runUntil(at, la('2026-10-12', '07:00'));
    const [issue] = await h.sql<{ state: string; item_count: number; quiet_reason: string }>(`SELECT * FROM issues WHERE issue = '2026-10-12'`);
    expect(issue).toMatchObject({ state: 'sent', quiet_reason: '' });
    const items = await h.sql<{ section: string }>(`SELECT section FROM issue_items WHERE issue = '2026-10-12'`);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((item) => item.section === 'research')).toBe(true);
    const bisect = await h.sql<{ n: number }>(`SELECT count(*) AS n FROM calls WHERE step = 'bisect'`);
    expect(bisect[0]?.n).toBeGreaterThan(0);
    expect(bisect[0]?.n).toBeLessThanOrEqual(4);
    expect((await h.opsStatus())['signals']).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'packet_refused', severity: 'info' })]));
  });

  it('falls back to the gate order after a refused pick and its retry', async () => {
    const { h, at } = await toMondayRun();
    h.claude.script = (_body, step) => (step === 'pick' ? { finishReason: 'refused' } : null);
    await h.runUntil(at, la('2026-10-12', '07:00'));
    expect(h.claude.steps().filter((step) => step === 'pick')).toHaveLength(2);
    const [issue] = await h.sql<{ state: string; pick_fallback: number; item_count: number }>(`SELECT * FROM issues WHERE issue = '2026-10-12'`);
    expect(issue).toMatchObject({ state: 'sent', pick_fallback: 1 });
    expect(issue?.item_count).toBeGreaterThan(0);
  });

  it('marks candidates Haiku refused twice and scores them by the fallback at the cutoff', async () => {
    const harness = await startHarness();
    h = harness;
    harness.claude.script = (body, step) => {
      if (step !== 'gate') return null;
      const content = (typeof body['input'] === 'string' ? body['input'] : '');
      return content.includes('Central bank') ? { finishReason: 'refused' } : null;
    };
    await harness.runUntil(la('2026-10-11', '12:30'), la('2026-10-12', '07:00'));
    const refused = await harness.sql<{ gate: string }>(`SELECT gate FROM items WHERE title LIKE 'Central bank%' AND candidate = 1`);
    expect(refused.length).toBeGreaterThan(0);
    // At the cutoff a refused world story took its cluster's score, passed on its independent sources, or stayed unscored.
    expect(refused.every((item) => ['fallback', 'unscored', 'refused'].includes(item.gate))).toBe(true);
    expect(refused.some((item) => item.gate !== 'refused')).toBe(true);
    const [usage] = await harness.sql<{ refused: number }>(`SELECT sum(refused) AS refused FROM usage`);
    expect(usage?.refused).toBeGreaterThan(0);
  });
});

describe('Router model failures', () => {
  it('stops on a rejected connection, sends the note 调用被拒, and resumes when the owner says so', async () => {
    const { h, at } = await toMondayRun();
    h.claude.script = (_body, step) => (step === 'write' ? modelError('MODEL_AUTH', 7) : null);
    await h.runUntil(at, la('2026-10-12', '07:00'));
    const [issue] = await h.sql<{ state: string; quiet_reason: string; error_code: string }>(`SELECT * FROM issues WHERE issue = '2026-10-12'`);
    expect(issue).toMatchObject({ state: 'sent', quiet_reason: 'calls_rejected' });
    expect(h.sent[0]?.body.subject).toBe('简报 · 10月12日：今日无条目');
    expect(h.sent[0]?.body.text).toContain('调用被拒');
    const status = await h.api.getServiceStatus({ name: 'serviceStatus' });
    expect(status.keyState).toBe(ServiceStatus_KeyState.REJECTED);
    expect(status.rejectedStatus).toBe(7);
    expect(status.rejectedErrorType).toBe('MODEL_AUTH');
    const ops = await h.opsStatus();
    expect(ops['health']).toBe('degraded');
    expect(ops['signals']).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'anthropic_rejected', severity: 'critical', metrics: { status: 7, model_auth: 1 } })]));
    expect(h.logs.join('\n')).not.toContain('synthetic error message');
    // While stopped, the next round's gate makes no call.
    const before = h.claude.requests.length;
    await h.runUntil(la('2026-10-12', '12:30'), la('2026-10-12', '12:40'));
    expect(h.claude.requests.length).toBe(before);
    const resumed = await h.api.resumeModelCalls({ name: 'serviceStatus', requestId: op() });
    expect(resumed.keyState).toBe(ServiceStatus_KeyState.OK);
  });

  it('retries a rate-limited model with backoff, without using an attempt', async () => {
    const { h, at } = await toMondayRun();
    let failures = 0;
    h.claude.script = (_body, step) => {
      if (step === 'write' && failures < 2) {
        failures++;
        return modelError('MODEL_RATE_LIMIT', 8);
      }
      return null;
    };
    await h.runUntil(at, la('2026-10-12', '07:00'));
    const writes = await h.sql<{ state: string }>(`SELECT state FROM calls WHERE step = 'write' ORDER BY id`);
    expect(writes.map((row) => row.state)).toEqual(['released', 'released', 'done']);
    const [issue] = await h.sql<{ state: string; quiet_reason: string }>(`SELECT * FROM issues WHERE issue = '2026-10-12'`);
    expect(issue).toMatchObject({ state: 'sent', quiet_reason: '' });
  });

  it('counts a write whose answers are no JSON: 3 attempts 15 minutes apart, then the note', async () => {
    const { h, at } = await toMondayRun();
    h.claude.script = (_body, step) => (step === 'write' ? { output: 'not json at all' } : null);
    await h.runUntil(at, la('2026-10-12', '08:00'));
    // Each answer is an attempt and is never read again (it once looped on the stored text for days).
    expect(h.claude.steps().filter((step) => step === 'write')).toHaveLength(3);
    expect(await h.sql(`SELECT id FROM calls WHERE step = 'write' AND answer != ''`)).toEqual([]);
    const [issue] = await h.sql<{ quiet_reason: string; error_code: string }>(`SELECT * FROM issues WHERE issue = '2026-10-12'`);
    expect(issue).toMatchObject({ quiet_reason: 'write_failed', error_code: 'write_attempts' });
    expect((await h.opsStatus())['signals']).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'issue_failed', severity: 'critical' })]));
  });

  it('halves a write that ran out of tokens (the same request would again): the halves make the issue', async () => {
    const { h, at } = await toMondayRun();
    h.claude.script = (body, step) => (step === 'write' && packetsIn(body) > 3 ? { finishReason: 'output_limit' } : null);
    await h.runUntil(at, la('2026-10-12', '07:00'));
    const calls = await h.sql<{ step: string }>(`SELECT step FROM calls WHERE step IN ('write', 'bisect') ORDER BY id`);
    expect(calls.map((call) => call.step)).toEqual(['write', 'bisect', 'bisect']);
    const sizes = h.claude.requests.filter((request) => request.step === 'write').map((request) => packetsIn(request.body));
    expect(sizes[1]).toBeLessThan(sizes[0] ?? 0);
    const [issue] = await h.sql<{ state: string; quiet_reason: string; item_count: number }>(`SELECT * FROM issues WHERE issue = '2026-10-12'`);
    expect(issue).toMatchObject({ state: 'sent', quiet_reason: '' });
    expect(issue?.item_count).toBe(sizes[0]);
  });

  it('ends a day whose writer stays rate limited at its send cutoff, and the next day runs', async () => {
    const { h, at } = await toMondayRun();
    const tried: number[] = [];
    h.claude.script = (_body, step) => {
      if (step !== 'write') return null;
      tried.push(h.now());
      return modelError('MODEL_RATE_LIMIT', 8);
    };
    await h.runUntil(at, la('2026-10-12', '13:00'));
    expect(tried.length).toBeGreaterThan(5);
    expect(Math.max(...tried)).toBeLessThan(la('2026-10-12', '12:00'));
    const [monday] = await h.sql<{ state: string; quiet_reason: string; error_code: string }>(`SELECT * FROM issues WHERE issue = '2026-10-12'`);
    expect(monday).toMatchObject({ state: 'archived', quiet_reason: 'write_failed', error_code: 'after_cutoff' });
    expect(await h.sql(`SELECT issue FROM runs WHERE done = 0`)).toEqual([]);
    h.claude.script = null;
    await h.runUntil(la('2026-10-12', '13:00'), la('2026-10-13', '07:00'));
    const [tuesday] = await h.sql<{ state: string; quiet_reason: string }>(`SELECT * FROM issues WHERE issue = '2026-10-13'`);
    expect(tuesday).toMatchObject({ state: 'sent', quiet_reason: '' });
  });

  it('sends the note when the writer leaves every packet out as too weak', async () => {
    const { h, at } = await toMondayRun();
    h.claude.script = (_body, step) => (step === 'write' ? jsonAnswer({ items: [], omitted: [{ packet: 'p1', code: 'weak' }] }) : null);
    await h.runUntil(at, la('2026-10-12', '07:00'));
    const [issue] = await h.sql<{ state: string; quiet_reason: string; error_code: string; item_count: number }>(`SELECT * FROM issues WHERE issue = '2026-10-12'`);
    expect(issue).toMatchObject({ state: 'sent', quiet_reason: 'no_candidates', error_code: 'all_omitted', item_count: 0 });
    expect(h.sent[0]?.body.subject).toBe('简报 · 10月12日：今日无条目');
  });
});

describe('the emergency stops during an issue', () => {
  it('a pause stops the issue model calls at once; the issue goes on when the owner resumes', async () => {
    const { h, at } = await toMondayRun();
    let t = await untilStep(h, at, 'shortlist');
    await h.api.updateSettings({ settings: { name: 'settings', paused: true }, updateMask: { paths: ['paused'] }, requestId: op() });
    const before = h.claude.requests.length;
    await h.runUntil(t, la('2026-10-12', '05:00'));
    expect(h.claude.requests.length).toBe(before);
    const [parked] = await h.sql<{ step: string; not_before_ms: number }>(`SELECT step, not_before_ms FROM runs WHERE issue = '2026-10-12'`);
    expect(parked?.step).toBe('write');
    expect(parked?.not_before_ms).toBeGreaterThan(la('2026-10-12', '05:00') - 20 * 60_000);
    expect(await h.sql(`SELECT id FROM calls WHERE issue = '2026-10-12' AND step = 'write'`)).toEqual([]);
    await h.api.updateSettings({ settings: { name: 'settings', paused: false }, updateMask: { paths: ['paused'] }, requestId: op() });
    t = la('2026-10-12', '05:00');
    await h.runUntil(t, la('2026-10-12', '07:00'));
    const [issue] = await h.sql<{ state: string; quiet_reason: string }>(`SELECT * FROM issues WHERE issue = '2026-10-12'`);
    expect(issue).toMatchObject({ state: 'sent', quiet_reason: '' });
  });

  it('a pause that lasts past the cutoff ends the day: archived, with its reason, without another call', async () => {
    const { h, at } = await toMondayRun();
    const t = await untilStep(h, at, 'shortlist');
    await h.api.updateSettings({ settings: { name: 'settings', paused: true }, updateMask: { paths: ['paused'] }, requestId: op() });
    const before = h.claude.requests.length;
    await h.runUntil(t, la('2026-10-12', '12:20'));
    expect(h.claude.requests.length).toBe(before);
    const [issue] = await h.sql<{ state: string; error_code: string }>(`SELECT * FROM issues WHERE issue = '2026-10-12'`);
    expect(issue).toMatchObject({ state: 'archived', error_code: 'paused' });
    expect(h.sent).toHaveLength(0);
  });

  it('BRIEF_MODE=off and a redeploy during a write: the killed call is not run again, no new call starts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'brief-redeploy-'));
    try {
      const { h: first, at } = await toMondayRun({ persist: dir });
      const t = await untilStep(first, at, 'write');
      // The write was in flight when the deploy landed: its call row is open, of the old build.
      await first.sql(`INSERT INTO calls (issue, step, attempt, build, model, state, reserved, day, month, started_ms) VALUES ('2026-10-12', 'write', 1, 'test', 'claude-opus-5-5', 'open', 1.85, '2026-10-12', '2026-10', ?)`, t);
      await first.dispose();
      h = null;
      const second = await startHarness({ persist: dir, bindings: { MODE: 'off', BUILD_SHA: 'test-off' } });
      h = second;
      await second.runUntil(t, la('2026-10-12', '12:30'));
      expect(second.claude.requests).toHaveLength(0);
      expect(await second.sql(`SELECT state, error FROM calls WHERE step = 'write'`)).toEqual([{ state: 'killed', error: 'deploy_killed' }]);
      const [issue] = await second.sql<{ state: string; error_code: string }>(`SELECT * FROM issues WHERE issue = '2026-10-12'`);
      expect(issue).toMatchObject({ state: 'archived', error_code: 'mode_off' });
    } finally {
      await h?.dispose();
      h = null;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the read and the gate', () => {
  it('never waits on a host that backs off: its document keeps the feed text and the read ends at once', async () => {
    const { h, at } = await toMondayRun();
    for (const { link } of await h.sql<{ link: string }>(`SELECT link FROM items WHERE link LIKE 'https://lab.synthetic-ai.org/blog/post-%'`)) {
      h.web.overrides.set(link, () => new Response('slow down', { status: 429, headers: { 'retry-after': '7200' } }));
    }
    await h.runUntil(at, la('2026-10-12', '07:00'));
    const lab = await h.sql<{ scope: string; state: string; fetched_ms: number }>(`SELECT scope, state, fetched_ms FROM texts WHERE issue = '2026-10-12' AND uri LIKE 'https://lab.synthetic-ai.org/%'`);
    expect(lab.length).toBeGreaterThan(0);
    expect(lab.every((text) => text.state === 'done' && text.scope !== 'full_text')).toBe(true);
    expect(Math.max(...lab.map((text) => text.fetched_ms))).toBeLessThan(la('2026-10-12', '03:45'));
    const [issue] = await h.sql<{ state: string }>(`SELECT state FROM issues WHERE issue = '2026-10-12'`);
    expect(issue?.state).toBe('sent');
  });

  it('leaves candidates pending when a gate call fails mid-stream: only a refusal marks them refused', async () => {
    const harness = await startHarness();
    h = harness;
    harness.claude.script = (_body, step) => (step === 'gate' ? modelError('MODEL_UNAVAILABLE', 14) : null);
    await harness.runUntil(la('2026-10-11', '12:30'), la('2026-10-11', '13:00'));
    expect(await harness.sql(`SELECT rowid FROM items WHERE gate = 'refused'`)).toEqual([]);
    const [pending] = await harness.sql<{ n: number }>(`SELECT count(*) AS n FROM items WHERE gate = 'pending'`);
    expect(pending?.n).toBeGreaterThan(0);
    // Bounded: at most the round's ten calls.
    expect(harness.claude.steps().filter((step) => step === 'gate').length).toBeLessThanOrEqual(10);
  });
});

describe('never repeat', () => {
  it('a world story that ran comes back only marked 已报道, and 还有 lists a title once', async () => {
    const { h, at } = await toMondayRun();
    await h.runUntil(at, la('2026-10-13', '07:00'));
    const clusters = (await h.sql<{ cluster: number }>(`SELECT DISTINCT cluster FROM items WHERE ran = '2026-10-12' AND section = 'world'`)).map((row) => row.cluster);
    expect(clusters.length).toBeGreaterThan(0);
    // Every member a story had when it ran has run with it.
    const left = await h.sql(`SELECT rowid FROM items WHERE cluster IN (${clusters.join(',')}) AND ran IS NULL AND fetched_ms < ?`, la('2026-10-12', '03:30'));
    expect(left).toEqual([]);
    // Tuesday: a later member of such a story makes a card marked 已报道 with the title that ran.
    const pick = h.claude.requests.filter((request) => request.step === 'pick')[1]?.body ?? {};
    const content = (typeof pick['input'] === 'string' ? pick['input'] : '');
    const world = JSON.parse(content.split('世界与经济卡片：\n')[1]?.split('\n')[0] ?? '[]') as { id: string; held_back?: string }[];
    const back = world.filter((card) => clusters.includes(Number(card.id.slice(1))));
    expect(back.length).toBeGreaterThan(0);
    expect(back.every((card) => card.held_back?.startsWith('已报道：') === true)).toBe(true);
    // 还有: the titles Monday listed are not listed again on Tuesday.
    const [monday, tuesday] = (await h.sql<{ more: string }>(`SELECT more FROM issues ORDER BY issue`)).map((row) => (JSON.parse(row.more) as { title: string }[]).map((entry) => entry.title));
    expect(monday?.length).toBeGreaterThan(0);
    expect((tuesday ?? []).filter((title) => monday?.includes(title))).toEqual([]);
  });
});

describe('the deep read', () => {
  it('reads the thread first 4 documents after a deep read ran out of tokens, at once', async () => {
    const harness = await startHarness();
    h = harness;
    let deepReads = 0;
    harness.claude.script = (body, step) => {
      if (step === 'deep_pick') {
        const content = (typeof body['input'] === 'string' ? body['input'] : '');
        const cards = JSON.parse(content.split('本周卡片：\n')[1]?.split('\n')[0] ?? '[]') as { id: string; full_text: string }[];
        const readable = cards.filter((card) => card.full_text === '可读全文').slice(0, 8);
        return jsonAnswer({ threads: [{ title: '断层如何慢慢滑动', angle: '从观测到机制', ids: readable.map((card) => card.id), reason: '本周有多篇全文' }] });
      }
      if (step === 'deep_read' && deepReads++ === 0) return { finishReason: 'output_limit' };
      return null;
    };
    await harness.runUntil(la('2026-10-16', '12:30'), la('2026-10-17', '09:00'));
    const documents = harness.claude.requests.filter((request) => request.step === 'deep_read').map((request) => {
      const content = (typeof request.body['input'] === 'string' ? request.body['input'] : '');
      return (JSON.parse(content.split('材料包：\n')[1]?.split('\n')[0] ?? '{}') as { documents: unknown[] }).documents.length;
    });
    expect(documents[0]).toBeGreaterThan(4);
    expect(documents.slice(1)).toEqual([4]);
    const [saturday] = await harness.sql<{ state: string; quiet_reason: string }>(`SELECT * FROM issues WHERE issue = '2026-10-17'`);
    expect(saturday).toMatchObject({ state: 'sent', quiet_reason: '' });
  });
});

describe('deploys and crashes', () => {
  it('a deploy that killed a step or a call does not count; a crash does, and three of them give up', async () => {
    const { h, at: start } = await toMondayRun();
    // Every step of the run, each time as if a deploy (an older build) had killed it mid-way: it runs again.
    let at = start;
    for (let i = 0; i < 12; i++) {
      const [run] = await h.sql<{ step: string; done: number }>(`SELECT step, done FROM runs WHERE issue = '2026-10-12'`);
      if (run === undefined || run.done === 1 || run.step === 'send') break;
      await h.sql(`UPDATE runs SET open_build = 'aaaaaaa', open_ms = 1 WHERE issue = '2026-10-12'`);
      if (run.step === 'write') {
        await h.sql(`INSERT INTO calls (issue, step, attempt, build, model, state, reserved, day, month, started_ms) VALUES ('2026-10-12', 'write', 1, 'aaaaaaa', 'claude-opus-5-5', 'open', 1.85, '2026-10-12', '2026-10', 1)`);
      }
      const result = await h.step(at);
      at = Math.max(result.next, at + SECOND);
    }
    const [run] = await h.sql<{ crashes: number }>(`SELECT crashes FROM runs WHERE issue = '2026-10-12'`);
    expect(run?.crashes).toBe(0);
    const killed = await h.sql<{ state: string; error: string }>(`SELECT state, error FROM calls WHERE step = 'write' AND build = 'aaaaaaa'`);
    expect(killed).toEqual([{ state: 'killed', error: 'deploy_killed' }]);
    const writes = await h.sql<{ n: number }>(`SELECT count(*) AS n FROM calls WHERE step = 'write' AND state IN ('done', 'failed')`);
    expect(writes[0]?.n).toBe(1);
    await h.runUntil(at, la('2026-10-12', '07:00'));
    expect(h.sent).toHaveLength(1);
  });

  it('counts a crash of this build and gives up a step at the third, in the note', async () => {
    const { h, at: start } = await toMondayRun();
    let at = start;
    for (let i = 0; i < 6; i++) {
      const [run] = await h.sql<{ step: string }>(`SELECT step FROM runs WHERE issue = '2026-10-12'`);
      if (run?.step === 'read') break;
      const result = await h.step(at);
      at = Math.max(result.next, at + SECOND);
    }
    // One crash: counted (and the step runs again).
    await h.sql(`UPDATE runs SET open_build = 'test', open_ms = 1 WHERE issue = '2026-10-12'`);
    await h.step(at);
    expect((await h.sql<{ value: string }>(`SELECT value FROM meta WHERE key = 'recent_errors'`))[0]?.value).toContain('step_crashed');
    // A step whose two crashes are on record crashes a third time: it gives up.
    await h.sql(`UPDATE runs SET step = 'read', open_build = 'test', open_ms = 1, crashes = 2 WHERE issue = '2026-10-12'`);
    const result = await h.step(at + SECOND);
    expect(result.code).toBe('crashed_read');
    await h.runUntil(at + 2 * SECOND, la('2026-10-12', '07:00'));
    const [issue] = await h.sql<{ quiet_reason: string; error_code: string }>(`SELECT * FROM issues WHERE issue = '2026-10-12'`);
    expect(issue).toMatchObject({ quiet_reason: 'write_failed', error_code: 'crashed_read' });
  });
});

describe('the ledger', () => {
  it('never sends an unknown outcome again', async () => {
    const { h, at } = await toMondayRun();
    h.resend.push({ status: 500, body: { message: 'synthetic' } });
    await h.runUntil(at, la('2026-10-12', '11:00'));
    expect(h.sent).toHaveLength(1);
    const [issue] = await h.sql<{ state: string; error_code: string }>(`SELECT * FROM issues WHERE issue = '2026-10-12'`);
    expect(issue).toMatchObject({ state: 'send_unknown', error_code: 'resend_500' });
    expect((await h.opsStatus())['signals']).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'send_unknown', severity: 'critical' })]));
  });
});

describe('the walls and the switches', () => {
  it('ends the day with the note 预算已用完 when the month budget leaves no room', async () => {
    const { h, at } = await toMondayRun();
    await h.api.updateSettings({ settings: { name: 'settings', monthlyBudgetUsd: 5 }, updateMask: { paths: ['monthly_budget_usd'] }, requestId: op() });
    await h.sql(`INSERT INTO calls (issue, step, attempt, build, model, state, reserved, cost, day, month, started_ms) VALUES ('2026-10-01', 'write', 1, 'test', 'claude-opus-5-5', 'done', 1.8, 4.9, '2026-10-01', '2026-10', 1)`);
    await h.runUntil(at, la('2026-10-12', '07:00'));
    const [issue] = await h.sql<{ quiet_reason: string; state: string }>(`SELECT * FROM issues WHERE issue = '2026-10-12'`);
    expect(issue).toMatchObject({ quiet_reason: 'budget_spent', state: 'sent' });
    expect(h.sent[0]?.body.text).toContain('预算已用完');
    expect((await h.opsStatus())['signals']).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'budget_spent', severity: 'critical' })]));
  });

  it('makes no issue while paused, and archives it in archive mode', async () => {
    const harness = await startHarness();
    h = harness;
    await harness.api.updateSettings({ settings: { name: 'settings', paused: true }, updateMask: { paths: ['paused'] }, requestId: op() });
    await harness.runUntil(la('2026-10-11', '12:30'), la('2026-10-12', '07:00'));
    expect(await harness.sql(`SELECT issue FROM runs`)).toEqual([]);
    expect(harness.claude.requests).toHaveLength(0);
    expect(harness.sent).toHaveLength(0);
    await harness.dispose();
    const archive = await startHarness({ bindings: { MODE: 'archive' } });
    h = archive;
    await archive.runUntil(la('2026-10-11', '12:30'), la('2026-10-12', '08:00'));
    const [issue] = await archive.sql<{ state: string; error_code: string; shadow: number }>(`SELECT * FROM issues WHERE issue = '2026-10-12'`);
    expect(issue).toMatchObject({ state: 'archived', error_code: 'mode_archive', shadow: 0 });
    expect(archive.sent).toHaveLength(0);
    expect((await archive.opsStatus())['modes']).toMatchObject({ mode_limited: true });
  });

  it('tags the shadow week in the subject', async () => {
    const shadow = await startHarness({ bindings: { MODE: 'shadow' } });
    h = shadow;
    await shadow.runUntil(la('2026-10-11', '12:30'), la('2026-10-12', '08:00'));
    expect(shadow.sent[0]?.body.subject).toBe('[影子版] 简报 · 10月12日（周一）');
  });

  it('makes no issue and no model call without the Model Router binding', async () => {
    const harness = await startHarness({ modelRouter: false });
    h = harness;
    await harness.runUntil(la('2026-10-11', '12:30'), la('2026-10-12', '08:00'));
    expect(harness.claude.requests).toHaveLength(0);
    expect(await harness.sql(`SELECT issue FROM runs`)).toEqual([]);
    expect((await harness.opsStatus())['signals']).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'anthropic_not_configured' })]));
    const items = await harness.sql<{ n: number }>(`SELECT count(*) AS n FROM items WHERE gate = 'pending'`);
    expect(items[0]?.n).toBeGreaterThan(0);
  });
});

describe('the owner API', () => {
  it('preserves the owner budget through a redeploy, Ops reads and a pause-only settings update', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'brief-budget-redeploy-'));
    try {
      const first = await startHarness({ persist: dir, bindings: { MODE: 'archive' } });
      h = first;
      await first.clock(la('2026-10-11', '12:00'));
      await first.api.updateSettings({ settings: { name: 'settings', monthlyBudgetUsd: 80 }, updateMask: { paths: ['monthly_budget_usd'] }, requestId: op() });
      await first.dispose();
      h = null;

      const second = await startHarness({ persist: dir, bindings: { MODE: 'archive', BUILD_SHA: 'test-monitoring' } });
      h = second;
      await second.clock(la('2026-10-11', '12:01'));
      expect(await second.api.getSettings({ name: 'settings' })).toMatchObject({ monthlyBudgetUsd: 80, paused: false });
      for (let read = 0; read < 2; read++) {
        expect(await second.opsStatus()).toMatchObject({ counters: { budget_month_cents: 8000 }, modes: { mode_limited: true } });
      }
      await second.api.updateSettings({ settings: { name: 'settings', paused: true }, updateMask: { paths: ['paused'] }, requestId: op() });
      expect(await second.api.getSettings({ name: 'settings' })).toMatchObject({ monthlyBudgetUsd: 80, paused: true });
      expect(await second.opsStatus()).toMatchObject({ counters: { budget_month_cents: 8000 }, modes: { paused: true } });
      expect(second.claude.requests).toHaveLength(0);
      expect(second.sent).toHaveLength(0);
    } finally {
      await h?.dispose();
      h = null;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the settings rules: an explicit mask, the budget range, the etag, AIP-155', async () => {
    const harness = await startHarness();
    h = harness;
    const settings = await harness.api.getSettings({ name: 'settings' });
    expect(settings).toMatchObject({ paused: false, monthlyBudgetUsd: 40 });
    expect(reasonOf(await rejection(harness.api.updateSettings({ settings: { name: 'settings', paused: true }, requestId: op() })))).toBe('BAD_REQUEST');
    expect(reasonOf(await rejection(harness.api.updateSettings({ settings: { name: 'settings', monthlyBudgetUsd: 500 }, updateMask: { paths: ['monthly_budget_usd'] }, requestId: op() })))).toBe('INVALID_SETTINGS');
    expect(reasonOf(await rejection(harness.api.updateSettings({ settings: { name: 'settings', paused: true, etag: 'stale' }, updateMask: { paths: ['paused', 'etag'] }, requestId: op() })))).toBe('ETAG_MISMATCH');
    const id = op();
    const first = await harness.api.updateSettings({ settings: { name: 'settings', monthlyBudgetUsd: 30 }, updateMask: { paths: ['monthly_budget_usd'] }, requestId: id });
    const again = await harness.api.updateSettings({ settings: { name: 'settings', monthlyBudgetUsd: 30 }, updateMask: { paths: ['monthly_budget_usd'] }, requestId: id });
    expect(again.etag).toBe(first.etag);
    expect(reasonOf(await rejection(harness.api.getIssue({ name: 'issues/2026-01-01' })))).toBe('NOT_FOUND');
    const profile = await harness.api.resetProfile({ name: 'profile', requestId: op() });
    expect(profile.topics.map((topic) => topic.topic)).toContain('geo.seismology');
    expect(profile.resetTime).toBeDefined();
    // A mutation without the CSRF token is refused before the body is read.
    const refused = await harness.fetch('/api/v1/settings?update_mask=paused', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'settings', paused: true }) });
    expect(refused.status).toBe(403);
  });

  it('applies the guard: embeddings wait, and setGuard answers the stored state', async () => {
    const harness = await startHarness();
    h = harness;
    await harness.clock(la('2026-10-11', '12:00'));
    const until = new Date(la('2026-10-11', '20:00')).toISOString().replace('.000Z', 'Z');
    expect(await harness.opsSetGuard({ level: 'shed', reason: 'neurons_high', until })).toMatchObject({ level: 'shed', deferred: ['embedding', 'learning', 'source_probe'] });
    await harness.runUntil(la('2026-10-11', '12:30'), la('2026-10-11', '12:35'));
    const [embedded] = await harness.sql<{ n: number }>(`SELECT count(*) AS n FROM embeddings`);
    expect(embedded?.n).toBe(0);
    expect((await harness.opsStatus())['signals']).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'guard_shed' })]));
  });
});
