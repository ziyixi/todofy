/**
 * SQLite rows read and written in workerd (../../../docs/design.md §14): Workers Free gives the account's SQLite
 * Durable Objects 5,000,000 rows read and 100,000 rows written a day, shared with Mail Hero, the watch app, mailsort and
 * recall, and every API call and alarm fails past them until 00:00 UTC. BriefState counts what each statement read and
 * wrote (store.ts `takeMeter`); this suite runs the brief at its bounds (bulk.ts: 40 feeds of 50 entries, 120 new
 * candidates a round, 3 days of world centroids, the largest pick and answer) and holds each path to a row budget:
 *
 * - the first round of a new registry (every entry new), a round's polls and its embedding, clustering and gate, a
 *   round with nothing new;
 * - an issue's whole pipeline, from its creation to the send;
 * - the UI's reads (ListIssues, GetIssue, ListItems, ListSources, GetServiceStatus, GetProfile) and an idle alarm;
 * - a day at the bounds: four rounds, the issue, 50 UI reads and 20 idle alarms.
 *
 * The budgets are measured values with room (the comments give what was measured on 2026-10-10).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BULK_SOURCES, bulkRegistry, FEED_ENTRIES, largestPick, largestWrite, NEW_ENTRIES, seedVectors, serveBulkFeeds } from './bulk.ts';
import { la, MINUTE, SECOND, startHarness, type AlarmResult, type Harness } from './harness.ts';

interface Rows {
  read: number;
  written: number;
}

let h: Harness;
const measured = new Map<string, Rows>();

async function metered(label: string, run: () => Promise<unknown>): Promise<Rows> {
  await h.rows();
  await run();
  const rows = await h.rows();
  measured.set(label, rows);
  return rows;
}

function codes(results: readonly AlarmResult[]): string {
  return results.map((result) => `${result.job}${result.step === undefined ? '' : `/${result.step}`}:${result.code}`).join(' ');
}

beforeAll(async () => {
  h = await startHarness({ registry: bulkRegistry() });
}, 120_000);

afterAll(async () => {
  console.log(`rows: ${[...measured].map(([label, rows]) => `${label} ${String(rows.read)} read, ${String(rows.written)} written`).join('; ')}`);
  await h.dispose();
});

describe('SQLite rows at the bounds', () => {
  it('holds every path and a day to its budget', { timeout: 600_000 }, async () => {
    const feeds = serveBulkFeeds(h);
    // The first round of a new registry: every entry is new (47 of each feed's 50).
    const first = la('2026-10-11', '12:30');
    const baseline = await metered('first round, polls', () => h.step(first));
    expect(await h.sql<{ n: number }>(`SELECT count(*) AS n FROM items`)).toEqual([{ n: BULK_SOURCES * (FEED_ENTRIES - NEW_ENTRIES) }]);
    // Measured 2026-10-10: 5,805 read, 11,508 written (about 6 a new item: its row and its index entries).
    expect(baseline.read).toBeLessThan(8_500);
    expect(baseline.written).toBeLessThan(16_000);
    // The baseline is settled as an earlier round's would be (embedded, screened below the bar), then idle.
    await h.sql(`UPDATE items SET embedded = 1, gate = 'scored', topic = 'ml.other', score = 2, gate_day = '2026-10-11'`);
    await h.runUntil(first + SECOND, first + 30 * MINUTE, 20);

    // A round at the bounds: 40 polls of 1 MiB, 120 new candidates, then their vectors, clusters and gate.
    const round = la('2026-10-11', '18:30');
    await seedVectors(h, round);
    feeds.entries = FEED_ENTRIES;
    let polls: AlarmResult = { job: '', code: '', next: 0 };
    const pollRows = await metered('round polls', async () => {
      polls = await h.step(round);
    });
    expect(polls.code).toBe('embedding');
    let screen: AlarmResult = { job: '', code: '', next: 0 };
    const screenRows = await metered('round embedding and gate', async () => {
      screen = await h.step(round + SECOND);
    });
    expect(screen.code).toBe('ok');
    expect(await h.sql(`SELECT count(*) AS n FROM items WHERE gate = 'pending' OR embedded = 0`)).toEqual([{ n: 0 }]);
    // Measured: polls 4,568 read, 864 written; embedding and gate 6,363 read, 649 written.
    expect(pollRows.read).toBeLessThan(6_500);
    expect(pollRows.written).toBeLessThan(1_200);
    expect(screenRows.read).toBeLessThan(9_000);
    expect(screenRows.written).toBeLessThan(900);
    await h.runUntil(round + 2 * SECOND, round + 30 * MINUTE, 20);

    // A round with nothing new.
    const quiet = la('2026-10-11', '23:30');
    const quietRows = await metered('round with nothing new', () => h.runUntil(quiet, quiet + 30 * MINUTE, 20));
    // Measured: 4,440 read, 86 written.
    expect(quietRows.read).toBeLessThan(6_500);
    expect(quietRows.written).toBeLessThan(150);

    // The cutoff round, then the issue from its creation to the send, at its largest: each alarm metered on its own.
    h.claude.script = (body, step) => (step === 'pick' ? largestPick(body) : step === 'write' ? largestWrite(body) : null);
    const steps: AlarmResult[] = [];
    const issueRows: Rows = { read: 0, written: 0 };
    await h.rows();
    for (let at = la('2026-10-12', '03:30'), i = 0; at <= la('2026-10-12', '09:00') && i < 60; i++) {
      const result = await h.step(at);
      const rows = await h.rows();
      if (result.job === 'create' || result.job === 'issue') {
        steps.push(result);
        issueRows.read += rows.read;
        issueRows.written += rows.written;
      }
      at = Math.max(result.next, at + SECOND);
    }
    measured.set('issue pipeline', issueRows);
    expect(codes(steps)).toContain('issue/send:send_accepted');
    const [issue] = await h.sql<{ state: string; n: number }>(`SELECT state, (SELECT count(*) FROM issue_items WHERE issue = issues.issue) AS n FROM issues`);
    expect(issue).toEqual({ state: 'sent', n: 8 });
    // Every quote was one word off its source: the alignment found each span (the source's words, never the quote's).
    const quotes = (await h.sql<{ citations: string }>(`SELECT citations FROM issue_items`)).flatMap((row) => (JSON.parse(row.citations) as { quote: string }[]).map((citation) => citation.quote));
    expect(quotes).toHaveLength(5 * 10 + 3 * 6);
    expect(quotes.every((quote) => quote.includes('coherent') && !quote.includes('consistent'))).toBe(true);
    // Measured: 7,162 read, 141 written.
    expect(issueRows.read).toBeLessThan(11_000);
    expect(issueRows.written).toBeLessThan(250);

    // The UI's reads and an idle alarm.
    const ui = await metered('UI reads (6 calls)', async () => {
      await h.api.listIssues({});
      await h.api.getIssue({ name: 'issues/2026-10-12' });
      await h.api.listItems({ parent: 'issues/2026-10-12' });
      await h.api.listSources({ pageSize: 100 });
      await h.api.getServiceStatus({ name: 'serviceStatus' });
      await h.api.getProfile({ name: 'profile' });
    });
    // Measured: 231 read, 0 written; an idle alarm 8 read, 1 written.
    expect(ui.read).toBeLessThan(400);
    expect(ui.written).toBe(0);
    const idle = await metered('idle alarm', () => h.step(la('2026-10-12', '10:00')));
    expect(idle.read).toBeLessThan(40);
    expect(idle.written).toBeLessThan(5);

    // A day at the bounds: four rounds like the measured one, the issue, 50 UI reads, 20 idle alarms.
    const day = (key: keyof Rows) => 4 * (pollRows[key] + screenRows[key]) + issueRows[key] + (50 / 6) * ui[key] + 20 * idle[key];
    console.log(`rows: a day at the bounds about ${String(Math.round(day('read')))} read, ${String(Math.round(day('written')))} written`);
    // Measured: about 53,000 read and 6,200 written: under 2 % of the account's rows read, 8 % of its rows written.
    expect(day('read')).toBeLessThan(100_000);
    expect(day('written')).toBeLessThan(8_000);
  });
});
