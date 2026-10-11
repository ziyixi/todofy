/** Real SQLite + the closed Gmail client over a synthetic mailbox. No network or personal content. */
import { describe, expect, it } from 'vitest';
import { applyFeedback } from '../src/feedback.ts';
import { checkRequest, GmailClient, GmailRefused, SCOPE_MODIFY, type Ownership } from '../src/gmail.ts';
import { canonicalDecision, effectiveLedgerRow } from '../src/label-identity.ts';
import { createLabelMerge, labelMergeStep, labelMergeSummary, mergeOwnership, migrationActive, resumeLabelMerge, type MergeContext } from '../src/label-merge.ts';
import { executeWrites } from '../src/writes.ts';
import { Budget } from '../src/session.ts';
import { DEFAULTS, writeSettings } from '../src/settings.ts';
import { Store, type LedgerRow } from '../src/store.ts';
import { FakeGmail } from './fakes/fake-gmail.ts';
import { memorySql } from './fakes/sql.ts';
import { allowedOperation } from './fakes/table.ts';

function required<T>(value: T | undefined | null): T { if (value == null) throw new Error('missing synthetic fixture'); return value; }

const NOW = Date.parse('2026-10-11T10:00:00Z');
function fixture(count = 1) {
  const sql = memorySql();
  const store = new Store(sql);
  store.migrate();
  const transact = <T>(fn: () => T): T => { sql.exec('BEGIN'); try { const result = fn(); sql.exec('COMMIT'); return result; } catch (error) { sql.exec('ROLLBACK'); throw error; } };
  const gmail = new FakeGmail();
  gmail.grants.set('synthetic-refresh', SCOPE_MODIFY);
  const parent = gmail.createUserLabel('Synthetic');
  store.run(`INSERT INTO gmail_parents (gmail_id, create_time) VALUES (?, ?)`, parent, NOW);
  const target = gmail.createUserLabel('Synthetic/Builds', true);
  const source = gmail.createUserLabel('Synthetic/Tools', true);
  const foreign = gmail.createUserLabel('Personal');
  for (const [id, gmailId, name] of [['target', target, 'Synthetic/Builds'], ['source', source, 'Synthetic/Tools']] as const) store.run(`INSERT INTO labels (id, seq, display_name, description, enabled, trust, gmail_id, gmail_state, create_time, update_time, etag) VALUES (?, 1, ?, 'synthetic description', 1, 0, ?, 'linked', ?, ?, 'first')`, id, name, gmailId, NOW, NOW);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = (0xa00000 + i).toString(16);
    ids.push(id);
    gmail.deliver({ id, threadId: id, labelIds: [source, 'UNREAD', 'STARRED', foreign, ...(i % 2 === 0 ? ['INBOX'] : [])], snippet: 'synthetic', internalDate: NOW - 90 * 86_400_000, payload: {} });
  }
  writeSettings(store, { ...DEFAULTS, mode: 'live', dailyWriteLimit: 1000 }, NOW);
  store.setMeta('write_scope', '1');
  let clock = NOW;
  let budget = new Budget(40);
  let lost: 'rename' | 'swap' | null = null;
  const ownership: Ownership = {
    ...mergeOwnership(store), ownedLabelIds: () => store.ownedGmailIds(), plannedPaths: () => new Set(store.labelPaths()), plannedPath: (id) => store.labelByGmailId(id)?.display_name ?? null,
    ledger: (id, label) => { const row = store.ledgerFor(id, label); return row === undefined ? null : { state: row.state, archived: row.archived === 1 }; },
  };
  const client = new GmailClient({ credentials: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh' }, ownership, now: () => clock,
    onCall: () => { budget.left--; }, fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const method = request.method;
      const body = method === 'GET' ? '' : await request.text();
      expect(allowedOperation(method, url.toString(), body, { owned: new Set([source, target]), planned: new Set(store.labelPaths()), ledger: (id, label) => ownership.ledger(id, label),
        merge: { labels: new Set([source, target, parent]), messages: new Set(ids), swaps: new Set(ids.map((id) => `${id}:${source}:${target}`)), hidden: new Set([source, parent]), names: new Set(['Projects']) } })).not.toBeNull();
      const response = gmail.handle(method, url, new Headers(init?.headers), body);
      if ((lost === 'rename' && method === 'PATCH' && body.includes('Projects')) || (lost === 'swap' && url.pathname.endsWith('/modify'))) { lost = null; throw new Error('synthetic response lost'); }
      return response;
    } });
  const ctx: MergeContext = { store, gmail: client, get budget() { return budget; }, now: () => clock, transact, canWrite: () => true };
  const create = () => transact(() => createLabelMerge(store, [{ sources: [{ labelId: 'target', etag: required(store.label('target')).etag }, { labelId: 'source', etag: required(store.label('source')).etag }], targetLabelId: 'target', displayName: 'Projects' }], clock, 'synthetic-job'));
  const pass = async () => { clock += 1000; budget = new Budget(40); await labelMergeStep(ctx); expect(budget.left).toBeGreaterThanOrEqual(0); };
  const complete = async () => { for (let i = 0; i < 100 && labelMergeSummary(store)?.state === 'running'; i++) await pass(); expect(labelMergeSummary(store)?.state).toBe('succeeded'); };
  return { store, gmail, target, source, parent, foreign, ids, ctx, ownership, create, pass, complete, lose: (kind: 'rename' | 'swap') => { lost = kind; } };
}

function originalLedger(h: ReturnType<typeof fixture>, targetPresent = false): LedgerRow {
  const id = required(h.ids[0]);
  if (targetPresent) required(h.gmail.messages.get(id)).labelIds.add(h.target);
  h.store.run(`INSERT INTO decisions (message_id, thread_id, received_at, decided_at, outcome, label_id, top_label, decider, probabilities, current_labels) VALUES (?, ?, ?, ?, 'applied', 'source', 'source', 'clef', '{"source":0.9,"none":0.1}', '["source"]')`, id, id, NOW, NOW);
  h.store.run(`INSERT INTO ledger (id, message_id, label_id, gmail_label_id, archived, origin, state, create_time) VALUES ('entry', ?, 'source', ?, 1, 'auto', 'applied', ?)`, id, h.source, NOW);
  return required(h.store.one<LedgerRow>(`SELECT * FROM ledger WHERE id = 'entry'`));
}

describe('private label consolidation', () => {
  it('renames IDs, moves all historical mail in bounded first pages, preserves other labels, and hides empty legacy labels', async () => {
    const h = fixture(27);
    const before = h.ids.map((id) => new Set(required(h.gmail.messages.get(id)).labelIds));
    h.create();
    await h.complete();
    expect(h.store.labels().map((label) => [label.id, label.display_name])).toEqual([['target', 'Projects']]);
    expect(h.store.label('source')?.gmail_id).toBe(h.source);
    expect(h.store.ownedGmailIds().has(h.source)).toBe(true);
    for (const [index, id] of h.ids.entries()) {
      const expected = required(before[index]);
      expected.delete(h.source); expected.add(h.target);
      expect(required(h.gmail.messages.get(id)).labelIds).toEqual(expected);
    }
    for (const id of [h.source, h.parent]) expect(h.gmail.labels.get(id)).toMatchObject({ labelListVisibility: 'labelHide', messageListVisibility: 'hide' });
    expect(labelMergeSummary(h.store)).toMatchObject({ processedCount: 27, phase: 'complete' });
    expect(h.gmail.calls.filter((call) => call.url.includes('/messages/') && call.method === 'GET').every((call) => new URL(call.url).searchParams.get('format') === 'minimal')).toBe(true);
    expect(h.store.usage('2026-10-11').applied).toBe(0);
  });

  it('resumes the same intent after a lost swap response, without sending that swap twice', async () => {
    const h = fixture(); h.create(); h.lose('swap');
    await h.pass();
    expect(labelMergeSummary(h.store)?.state).toBe('blocked');
    expect(required(h.gmail.messages.get(required(h.ids[0]))).labelIds.has(h.target)).toBe(true);
    resumeLabelMerge(h.store, 'synthetic-job', NOW + 2000);
    await h.complete();
    expect(h.gmail.calls.filter((call) => call.url.endsWith('/modify'))).toHaveLength(1);
  });

  it('rolls back preflight registration with its phase so an interrupted attempt can resume', async () => {
    const h = fixture(); h.create();
    const run = h.store.run.bind(h.store);
    let interrupt = true;
    h.store.run = (sql, ...values) => {
      if (interrupt && sql.includes("SET phase = 'rename'")) { interrupt = false; throw new Error('synthetic checkpoint interruption'); }
      return run(sql, ...values);
    };
    await h.pass();
    expect(labelMergeSummary(h.store)).toMatchObject({ state: 'blocked', phase: 'preflight' });
    expect(h.store.count(`SELECT count(*) AS n FROM label_merge_hides`)).toBe(0);
    h.store.run = run;
    resumeLabelMerge(h.store, 'synthetic-job', NOW + 2000); await h.complete();
  });

  it('reads back an interrupted rename and commits its description version only once', async () => {
    const h = fixture(); h.create(); h.lose('rename');
    await h.pass();
    expect(labelMergeSummary(h.store)?.state).toBe('blocked');
    expect(h.store.label('target')?.desc_version).toBe(1);
    resumeLabelMerge(h.store, 'synthetic-job', NOW + 2000);
    await h.complete();
    expect(h.store.label('target')?.desc_version).toBe(2);
    expect(h.gmail.calls.filter((call) => call.method === 'PATCH' && call.body.includes('Projects'))).toHaveLength(1);
  });

  it('keeps historical predictions frozen and read-only, and ignores only the migration history', async () => {
    const h = fixture(); const ledger = originalLedger(h);
    const prediction = required(h.store.decision(required(h.ids[0])));
    h.create(); await h.complete();
    const after = required(h.store.decision(required(h.ids[0])));
    expect([after.label_id, after.top_label, after.probabilities]).toEqual([prediction.label_id, prediction.top_label, prediction.probabilities]);
    expect(canonicalDecision(h.store, after).label_id).toBe('target');
    expect(effectiveLedgerRow(h.store, ledger)).toMatchObject({ label_id: 'target', gmail_label_id: h.source, archived: 1, superseded: 1 });
    for (const entry of h.gmail.history) for (const [kind, events] of [['added', entry.labelsAdded], ['removed', entry.labelsRemoved]] as const) for (const event of events ?? []) for (const label of event.labelIds) h.store.run(`INSERT INTO feedback (key, message_id, change, gmail_label_id, seq) VALUES (?, ?, ?, ?, ?)`, `${String(entry.id)}:${kind}:${label}`, event.message.id, kind, label, entry.id);
    applyFeedback(h.store, new Map([[h.source, 'source'], [h.target, 'target']]), NOW + 10000);
    expect(h.store.decision(required(h.ids[0]))?.verdict).toBeNull();
    expect(h.store.count(`SELECT count(*) AS n FROM examples`)).toBe(0);
    expect(h.store.one<LedgerRow>(`SELECT * FROM ledger WHERE id = 'entry'`)?.gmail_label_id).toBe(h.source);
  });

  it('does not let an old undo remove a target label that was already present', async () => {
    const h = fixture(); const ledger = originalLedger(h, true);
    h.create(); await h.complete();
    expect(effectiveLedgerRow(h.store, ledger).superseded).toBe(1);
  });

  it('blocks read-back when an owner changes an unrelated label during the swap', async () => {
    const h = fixture(); h.create();
    h.gmail.afterCall = (method, url) => { if (method === 'POST' && url.pathname.endsWith('/modify')) required(h.gmail.messages.get(required(h.ids[0]))).labelIds.delete('UNREAD'); };
    await h.pass();
    expect(labelMergeSummary(h.store)).toMatchObject({ state: 'blocked', errorCode: 'other_labels_changed' });
    expect(h.store.labels()).toHaveLength(2);
  });

  it('keeps merged historical writes read-only without sending Gmail undo requests', async () => {
    const h = fixture(); originalLedger(h); h.create(); await h.complete();
    h.store.run(`UPDATE ledger SET state = 'undo_intended' WHERE id = 'entry'`);
    const calls = h.gmail.calls.length;
    const result = await executeWrites({ ...h.ctx, gate: () => null }, ['entry'], 1);
    expect(result).toMatchObject({ undone: 0, failed: 1 });
    expect(h.gmail.calls).toHaveLength(calls);
    expect(h.store.ledgerRow('entry')).toMatchObject({ superseded: 1, last_code: 'merge_undo_unsafe' });
  });

  it('honors pauses and the existing daily write cap while preserving resumable work', async () => {
    const h = fixture(); h.create();
    await labelMergeStep({ ...h.ctx, canWrite: () => false });
    expect(h.gmail.calls).toHaveLength(0);
    writeSettings(h.store, { ...DEFAULTS, mode: 'live', dailyWriteLimit: 1 }, NOW);
    await h.pass();
    expect(labelMergeSummary(h.store)).toMatchObject({ state: 'blocked', errorCode: 'daily_write_limit' });
    expect(required(h.gmail.messages.get(required(h.ids[0]))).labelIds.has(h.source)).toBe(true);
    writeSettings(h.store, { ...DEFAULTS, mode: 'live', dailyWriteLimit: 1000 }, NOW);
    resumeLabelMerge(h.store, 'synthetic-job', NOW + 2000); await h.complete();
  });

  it('keeps an owned grouping parent visible when it is nonempty or still groups an unrelated child', async () => {
    const h = fixture(); required(h.gmail.messages.get(required(h.ids[0]))).labelIds.add(h.parent);
    h.gmail.createUserLabel('Synthetic/Personal'); h.create(); await h.complete();
    expect(h.gmail.labels.get(h.parent)?.labelListVisibility).not.toBe('labelHide');
    expect(required(h.gmail.messages.get(required(h.ids[0]))).labelIds.has(h.parent)).toBe(true);
  });

  it('refuses a resumed swap when the owner added the target after a failed attempt', async () => {
    const h = fixture(); originalLedger(h); h.create();
    h.gmail.failWhen = (method, url) => method === 'POST' && url.pathname.endsWith('/modify') ? 503 : null;
    await h.pass();
    expect(labelMergeSummary(h.store)?.state).toBe('blocked');
    h.gmail.ownerModify(required(h.ids[0]), [h.target], []);
    h.gmail.failWhen = null;
    const writes = h.gmail.calls.filter((call) => call.url.endsWith('/modify')).length;
    resumeLabelMerge(h.store, 'synthetic-job', NOW + 2000); await h.pass();
    expect(labelMergeSummary(h.store)).toMatchObject({ state: 'blocked', errorCode: 'message_changed' });
    expect(h.gmail.calls.filter((call) => call.url.endsWith('/modify'))).toHaveLength(writes);
    expect(required(h.gmail.messages.get(required(h.ids[0]))).labelIds.has(h.source)).toBe(true);
  });

  it('freezes identity and refuses stale, cross-group, policy-changing and pending-write plans', () => {
    const h = fixture();
    const one = { sources: [{ labelId: 'target', etag: 'stale' }], targetLabelId: 'target', displayName: 'Projects' };
    expect(() => createLabelMerge(h.store, [one], NOW, 'wrong')).toThrow('MERGE_ETAG_MISMATCH');
    h.store.run(`UPDATE labels SET trust = 1 WHERE id = 'source'`);
    expect(h.create).toThrow('MERGE_INVALID_PLAN');
    expect(migrationActive(h.store)).toBe(false);
    h.store.run(`UPDATE labels SET trust = 0 WHERE id = 'source'`);
    h.store.run(`INSERT INTO ledger (id, message_id, label_id, archived, origin, state, create_time) VALUES ('old', 'a00000', 'source', 1, 'auto', 'intended', ?)`, NOW);
    expect(h.create).toThrow('MERGE_PENDING_WRITES');
  });

  it('guard refuses unregistered lists, bodies, arbitrary swaps and hides before the empty proof', () => {
    const h = fixture(); h.create();
    const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
    expect(() => checkRequest({ method: 'POST', url: `${base}/messages/a00000/modify`, body: JSON.stringify({ addLabelIds: [h.target], removeLabelIds: [h.source] }) }, h.ownership)).toThrow(GmailRefused);
    expect(() => checkRequest({ method: 'PATCH', url: `${base}/labels/${h.source}`, body: JSON.stringify({ labelListVisibility: 'labelHide', messageListVisibility: 'hide' }) }, h.ownership)).toThrow(GmailRefused);
    expect(() => checkRequest({ method: 'GET', url: `${base}/messages?labelIds=${h.foreign}&maxResults=10&fields=messages/id,nextPageToken,resultSizeEstimate&includeSpamTrash=true` }, h.ownership)).toThrow(GmailRefused);
    expect(() => checkRequest({ method: 'GET', url: `${base}/messages/a00000?format=minimal&fields=id,labelIds,historyId` }, h.ownership)).toThrow(GmailRefused);
  });
});
