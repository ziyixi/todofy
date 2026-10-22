import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, expect, it } from 'vitest';
import { WorkStore, type WorkAttention, type WorkStorage } from '../src/work-store.ts';
import { registerWorkTools } from '../src/work-tools.ts';
import type { WorkCreateInput, WorkReportInput } from '../src/work-model.ts';

const databases: DatabaseSync[] = [];
const handlers: ReturnType<typeof createMcpHandler>[] = [];
afterEach(async () => {
  await Promise.all(handlers.splice(0).map(handler => handler.close()));
  for (const database of databases.splice(0)) database.close();
});

function uuid(value: number) { return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`; }

/** Exercise real SQLite statements without replacing the store's transactional behavior with JS maps. */
function fixture(callback?: (attention: WorkAttention, storage: WorkStorage) => void) {
  const database = new DatabaseSync(':memory:');
  databases.push(database);
  const sql = {
    exec(query: string, ...bindings: SqlStorageValue[]) {
      if (query.trimStart().startsWith('CREATE')) { database.exec(query); return { toArray: () => [] }; }
      const values = bindings.map(value => value instanceof ArrayBuffer ? new Uint8Array(value) : value) satisfies SQLInputValue[];
      const rows = database.prepare(query).all(...values);
      return { toArray: () => rows };
    },
  } as unknown as SqlStorage;
  let transaction = 0;
  const storage: WorkStorage = {
    sql,
    transactionSync<T>(action: () => T): T {
      const savepoint = `work_test_${String(++transaction)}`;
      database.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = action();
        database.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        database.exec(`ROLLBACK TO ${savepoint}`);
        database.exec(`RELEASE ${savepoint}`);
        throw error;
      }
    },
  };
  const attention: WorkAttention[] = [];
  const store = new WorkStore(storage, event => { callback?.(event, storage); attention.push(event); });
  return { store, storage, attention };
}

function create(store: WorkStore, number: number, fields: Partial<WorkCreateInput> = {}) {
  return store.create({ request_id: uuid(number), title: `Synthetic work ${String(number)}`,
    goal: 'Confirm a synthetic result', scope: 'Only synthetic resources', completion_criteria: 'Result is checked and dedicated follow-ups are stopped',
    next_action: 'Read the synthetic executor result', ...fields });
}

function report(workId: string, id = 'report-1'): WorkReportInput {
  return { work_id: workId, report_id: id, kind: 'progress', summary: 'Synthetic output is available for review',
    source: { type: 'codex', ref: 'synthetic-host/thread-1' } };
}

it('persists an owner objective and retries mutations without overwriting later checkpoints', () => {
  const { store, storage, attention } = fixture();
  const first = create(store, 1);
  expect(first.work).toMatchObject({ id: uuid(1), etag: '1', state: 'active', links: [] });
  expect(create(store, 1)).toMatchObject({ repeated: true, work: { id: uuid(1), etag: '1' } });
  expect(() => create(store, 1, { goal: 'Different synthetic objective' })).toThrow('request_id');
  const checkpoint = { request_id: uuid(2), work_id: first.work.id, etag: first.work.etag,
    changes: { checkpoint: 'Read the output; inspect the synthetic artifact next' },
    entry: { kind: 'fact' as const, summary: 'The executor accepted the request; completion remains unconfirmed' } };
  const saved = store.checkpoint(checkpoint);
  expect(saved.work.etag).toBe('2');
  const restarted = new WorkStore(storage);
  expect(restarted.checkpoint(checkpoint)).toMatchObject({ repeated: true, applied_etag: '2', work: { etag: '2' } });
  expect(create(restarted, 1)).toMatchObject({ repeated: true, applied_etag: '1', work: { etag: '2' } });
  expect(() => restarted.checkpoint({ ...checkpoint, request_id: uuid(3) })).toThrow('Read the work again');
  expect(restarted.get({ work_id: uuid(1) }).entries.map(entry => entry.kind)).toEqual(['fact', 'created']);
  expect(attention).toEqual([]);
});

it('deduplicates external reports, rejects payload conflicts and never reports work complete', () => {
  const { store, attention } = fixture();
  const work = create(store, 10, { state: 'waiting', waiting_for: 'A synthetic executor report',
    links: [{ type: 'codex', ref: 'synthetic-host/thread-1' }] }).work;
  const first = store.report(report(work.id));
  expect(first).toMatchObject({ repeated: false, attention: true });
  expect(store.report(report(work.id))).toMatchObject({ repeated: true, report_seq: first.report_seq });
  expect(() => store.report({ ...report(work.id), summary: 'Different result' })).toThrow('report_id');
  expect(() => store.report({ ...report(work.id, 'missing-source'), source: { type: 'codex', ref: 'not-linked' } })).toThrow('Attach the native source');
  const current = store.get({ work_id: work.id });
  expect(current.work).toMatchObject({ etag: '1', state: 'waiting', checkpoint: '', last_report_seq: first.report_seq });
  expect(current.pending_reports).toHaveLength(1);
  expect(attention).toHaveLength(1);
  expect(attention[0]).toMatchObject({ work_id: work.id, report_seq: first.report_seq, source: report(work.id).source });
  expect(JSON.stringify(attention)).not.toContain('output');
});

it('handles reports through N while a newer report remains pending and pages oldest pending reports first', () => {
  const { store } = fixture();
  const work = create(store, 20, { links: [{ type: 'codex', ref: 'synthetic-host/thread-1' }] }).work;
  const first = store.report(report(work.id, 'first'));
  store.report(report(work.id, 'second'));
  const read = store.get({ work_id: work.id, report_page_size: 1 });
  expect(read.pending_reports.map(entry => entry.report_id)).toEqual(['first']);
  expect(read.handled_through_candidate).toBe(first.report_seq);
  const later = store.report(report(work.id, 'third'));
  const saved = store.checkpoint({ work_id: work.id, etag: read.work.etag, request_id: uuid(21), changes: {},
    handled_through_report_seq: read.handled_through_candidate });
  expect(saved.work.last_report_seq).toBe(later.report_seq);
  const after = store.get({ work_id: work.id, report_page_size: 1 });
  expect(after.pending_reports.map(entry => entry.report_id)).toEqual(['second']);
  const next = store.get({ work_id: work.id, report_page_size: 1, report_page_token: after.next_report_page_token });
  expect(next.pending_reports.map(entry => entry.report_id)).toEqual(['third']);
  expect(() => store.checkpoint({ work_id: work.id, etag: saved.work.etag, request_id: uuid(22), changes: {},
    handled_through_report_seq: later.report_seq + 100 })).toThrow('report range');
  expect(() => store.checkpoint({ work_id: work.id, etag: saved.work.etag, request_id: uuid(23),
    changes: { state: 'done', result: 'Checked the synthetic result' } })).toThrow('pending reports');
});

it('rolls back the source report and callback queue together when enqueue fails', () => {
  let reject = true;
  const { store, storage } = fixture((event, database) => {
    database.sql.exec('INSERT INTO synthetic_callbacks VALUES (?)', event.event_id);
    if (reject) throw new Error('Synthetic enqueue failure');
  });
  storage.sql.exec('CREATE TABLE synthetic_callbacks (event_id TEXT PRIMARY KEY)');
  const work = create(store, 30, { links: [{ type: 'codex', ref: 'synthetic-host/thread-1' }] }).work;
  expect(() => store.report(report(work.id))).toThrow('Synthetic enqueue failure');
  expect(store.get({ work_id: work.id }).work.last_report_seq).toBe(0);
  expect(storage.sql.exec('SELECT * FROM synthetic_callbacks').toArray()).toEqual([]);
  reject = false;
  store.report(report(work.id));
  expect(store.get({ work_id: work.id }).pending_reports).toHaveLength(1);
  expect(storage.sql.exec('SELECT * FROM synthetic_callbacks').toArray()).toHaveLength(1);
});

it('keeps cancellation open until owned resources are observed stopped and protects shared Watch references', () => {
  const { store } = fixture();
  const work = create(store, 40, { links: [{ type: 'schedule', ref: 'synthetic-schedule', owned: true },
    { type: 'watch', ref: 'shared-watch' }] }).work;
  for (const changes of [{ state: 'cancelled' as const, result: 'Owner requested cancellation' }, { links: [] },
    { links: [{ type: 'schedule' as const, ref: 'synthetic-schedule', owned: false }] }]) {
    expect(() => store.checkpoint({ work_id: work.id, etag: work.etag, request_id: uuid(41), changes })).toThrow('resource');
  }
  const stopped = store.checkpoint({ work_id: work.id, etag: work.etag, request_id: uuid(42), changes: {
    state: 'cancelled', result: 'The native schedule is disabled; shared monitoring continues',
    links: [{ type: 'schedule', ref: 'synthetic-schedule', owned: true, stop_state: 'stopped',
      observed_at: '2026-10-22T12:00:00Z', observation: 'Native schedule reads disabled' },
    { type: 'watch', ref: 'shared-watch' }],
  } });
  expect(stopped.work).toMatchObject({ state: 'cancelled', review_at: null, next_action: '', waiting_for: '' });
  expect(stopped.work.links.find(link => link.type === 'watch')).toMatchObject({ owned: false, stop_state: 'unconfirmed' });
  expect(store.linkedWorkIds('watch', 'shared-watch')).toEqual([]);
});

it('recovers context in actionable order without treating review_at as a native scheduled wakeup', () => {
  const { store, storage } = fixture();
  const active = create(store, 50).work;
  const waiting = create(store, 51, { state: 'waiting', waiting_for: 'Owner selects the synthetic artifact' }).work;
  const due = create(store, 52, { review_at: '2000-01-01T00:00:00Z' }).work;
  const pending = create(store, 53, { links: [{ type: 'codex', ref: 'synthetic-host/thread-1' }] }).work;
  store.report(report(pending.id));
  const restored = new WorkStore(storage);
  const first = restored.context({ page_size: 2 });
  expect(first.works.map(work => [work.id, work.reason])).toEqual([[pending.id, 'report'], [due.id, 'review_due']]);
  const second = restored.context({ page_size: 2, page_token: first.next_page_token });
  expect(second.works.map(work => [work.id, work.reason])).toEqual([[waiting.id, 'waiting'], [active.id, 'next_action']]);
  expect(first.meaning).toContain('only a linked native schedule');
  expect(restored.get({ work_id: due.id }).work.links).toEqual([]);
});

it('keeps later context pages complete when previously returned work is finished between pages', () => {
  const { store } = fixture();
  const firstWork = create(store, 90).work;
  const secondWork = create(store, 91).work;
  const thirdWork = create(store, 92).work;
  const first = store.context({ page_size: 1 });
  expect(first.works.map(work => work.id)).toEqual([firstWork.id]);
  store.checkpoint({ work_id: firstWork.id, etag: firstWork.etag, request_id: uuid(93),
    changes: { state: 'done', result: 'Reviewed the first synthetic result' } });
  const second = store.context({ page_size: 1, page_token: first.next_page_token });
  expect(second.works.map(work => work.id)).toEqual([secondWork.id]);
  store.checkpoint({ work_id: secondWork.id, etag: secondWork.etag, request_id: uuid(94),
    changes: { state: 'done', result: 'Reviewed the second synthetic result' } });
  const third = store.context({ page_size: 1, page_token: second.next_page_token });
  expect(third.works.map(work => work.id)).toEqual([thirdWork.id]);
  expect(third.next_page_token).toBe('');
});

it('pages filtered lists and history, binds tokens to selectors and keeps review decisions local to work', () => {
  const { store, attention } = fixture();
  const first = create(store, 60, { links: [{ type: 'watch', ref: 'shared-synthetic-watch' }] }).work;
  const second = create(store, 61, { links: [{ type: 'watch', ref: 'shared-synthetic-watch' }] }).work;
  for (const [index, work] of [first, second].entries()) store.checkpoint({ work_id: work.id, etag: work.etag,
    request_id: uuid(62 + index), changes: {}, entry: { kind: 'watch_review', summary: 'Reviewed the shared synthetic change',
      review: { change_ref: 'shared-synthetic-watch/change-1', verdict: index === 0 ? 'relevant' : 'irrelevant',
        reason: index === 0 ? 'The result satisfies this objective' : 'This objective needs another result' } } });
  const page = store.list({ link_type: 'watch', link_ref: 'shared-synthetic-watch', page_size: 1 });
  expect(page.works.map(work => work.id)).toEqual([first.id]);
  expect(store.list({ link_type: 'watch', link_ref: 'shared-synthetic-watch', page_size: 1,
    page_token: page.next_page_token }).works.map(work => work.id)).toEqual([second.id]);
  expect(() => store.list({ state: 'all', page_token: page.next_page_token })).toThrow('same selectors');
  const history = store.get({ work_id: first.id, entry_page_size: 1 });
  expect(history.entries[0]?.review?.verdict).toBe('relevant');
  expect(store.get({ work_id: second.id }).entries[0]?.review?.verdict).toBe('irrelevant');
  expect(store.get({ work_id: first.id, entry_page_size: 1, entry_page_token: history.next_entry_page_token })
    .entries.map(entry => entry.kind)).toEqual(['created']);
  expect(attention).toEqual([]);
});

it('preserves Unicode link selectors across list page tokens', () => {
  const { store } = fixture();
  const ref = '/tmp/合成报告.pdf';
  const firstWork = create(store, 100, { links: [{ type: 'artifact', ref }] }).work;
  const secondWork = create(store, 101, { links: [{ type: 'artifact', ref }] }).work;
  const first = store.list({ link_type: 'artifact', link_ref: ref, page_size: 1 });
  expect(first.works.map(work => work.id)).toEqual([firstWork.id]);
  const second = store.list({ link_type: 'artifact', link_ref: ref, page_size: 1, page_token: first.next_page_token });
  expect(second.works.map(work => work.id)).toEqual([secondWork.id]);
  expect(second.next_page_token).toBe('');
  expect(() => store.list({ link_type: 'artifact', link_ref: '/tmp/另一份报告.pdf', page_token: first.next_page_token }))
    .toThrow('same selectors');
});

it('exports every record and meaningful entry through bounded pages without internal receipts', () => {
  const { store } = fixture();
  const work = create(store, 70).work;
  store.checkpoint({ work_id: work.id, etag: work.etag, request_id: uuid(71), changes: { checkpoint: 'Synthetic checkpoint' } });
  store.checkpoint({ work_id: work.id, etag: '2', request_id: uuid(72), changes: {},
    entry: { kind: 'decision', summary: 'Use the synthetic artifact', evidence_ref: 'artifact://synthetic' } });
  create(store, 73);
  const pages: ReturnType<WorkStore['export']>[] = [];
  let pageToken = '';
  do {
    const page = store.export({ page_size: 1, page_token: pageToken });
    pages.push(page);
    pageToken = page.next_page_token;
  } while (pageToken);
  expect(pages.filter(page => page.section === 'works').reduce((total, page) => total + page.records.length, 0)).toBe(2);
  expect(pages.filter(page => page.section === 'entries').reduce((total, page) => total + page.records.length, 0)).toBe(3);
  const serialized = JSON.stringify(pages);
  for (const field of ['input_fingerprint', 'request_id', 'mutation', 'callback', 'secret']) expect(serialized).not.toContain(field);
});

function tools(store: WorkStore, beforeRead: () => Promise<void>) {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'synthetic-work', version: '1' }, { capabilities: { tools: {} } });
    registerWorkTools(server, store, beforeRead);
    return server;
  }, { legacy: 'reject' });
  handlers.push(handler);
  return async (name: string, args: Record<string, unknown>) => {
    const response = await handler.fetch(new Request('https://mcp.example.org/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': name },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args,
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {},
          'io.modelcontextprotocol/clientInfo': { name: 'synthetic', version: '1' } } } }),
    }));
    return response.json<{ result?: CallToolResult; error?: { code: number; message: string } }>();
  };
}

it('registers MCP tools with source refresh only on context/get and validates writes at the protocol boundary', async () => {
  const { store } = fixture();
  const work = create(store, 80).work;
  let refreshes = 0;
  const call = tools(store, () => { refreshes++; return Promise.resolve(); });
  expect((await call('work_context', {})).result?.structuredContent).toHaveProperty('works');
  expect((await call('work_get', { work_id: work.id })).result?.structuredContent).toHaveProperty('work');
  await call('work_list', {});
  await call('work_export', {});
  expect(refreshes).toBe(2);
  const invalid = await call('work_checkpoint', { work_id: work.id, request_id: uuid(81), etag: work.etag,
    changes: { state: 'cancelled', result: '' } });
  expect(invalid.result?.isError).toBe(true);
  expect(store.get({ work_id: work.id }).work.state).toBe('active');
  expect((await call('work_report', { ...report(work.id), state: 'done' })).result?.isError).toBe(true);
});
