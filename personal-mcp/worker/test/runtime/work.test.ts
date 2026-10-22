import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { afterEach, expect, it } from 'vitest';
import type { Work, WorkAttention } from '../../src/work-model.ts';

const runtimes: Miniflare[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function start(persist: string) {
  const bundle = await build({ stdin: { resolveDir: process.cwd(), contents: `
    import { DurableObject } from 'cloudflare:workers';
    import { WorkStore } from './src/work-store.ts';
    export class WorkRuntime extends DurableObject {
      constructor(ctx, env) {
        super(ctx, env);
        this.failEnqueue = false;
        ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS callback_events (event_id TEXT PRIMARY KEY, body TEXT NOT NULL)');
        this.memory = new WorkStore(ctx.storage, event => {
          ctx.storage.sql.exec('INSERT INTO callback_events VALUES (?,?)', event.event_id, JSON.stringify(event));
          if (this.failEnqueue) throw new Error('Synthetic queue failure');
        });
      }
      async fetch(request) {
        const input = await request.json();
        this.failEnqueue = input.fail_enqueue === true;
        try {
          if (input.method === 'callbacks') return Response.json(this.ctx.storage.sql.exec('SELECT body FROM callback_events ORDER BY event_id').toArray().map(row => JSON.parse(row.body)));
          return Response.json(this.memory[input.method](input.arguments));
        } catch { return Response.json({ error: 'synthetic_request_failed' }, { status: 500 }); }
        finally { this.failEnqueue = false; }
      }
    }
    export default { fetch(request, env) { return env.WORK.getByName('synthetic-work-memory').fetch(request); } };
  ` }, bundle: true, format: 'esm', platform: 'browser', conditions: ['workerd', 'worker', 'browser'],
  target: 'es2024', external: ['cloudflare:workers', 'node:*'], write: false, logLevel: 'silent' });
  const output = bundle.outputFiles[0];
  if (!output) throw new Error('Missing synthetic runtime bundle');
  const runtime = new Miniflare(convertV4MiniflareOptions({ resourcePersistencePath: persist, workers: [{
    name: 'synthetic-work-memory', script: output.text, modules: true, compatibilityDate: '2026-09-08',
    compatibilityFlags: ['nodejs_compat'], durableObjects: { WORK: { className: 'WorkRuntime', useSQLite: true } },
  }] }));
  runtimes.push(runtime);
  await runtime.ready;
  return runtime;
}

async function call<T>(runtime: Miniflare, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await runtime.dispatchFetch('https://synthetic.internal/', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method, arguments: args }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<T>;
}

it('persists reports and callback enqueue atomically in real SQLite DO across restart', async () => {
  const persist = await mkdtemp(join(tmpdir(), 'personal-work-runtime-'));
  directories.push(persist);
  const first = await start(persist);
  const id = '00000000-0000-4000-8000-000000000201';
  const created = await call<{ work: Work }>(first, 'create', { request_id: id, title: 'Synthetic workerd job',
    goal: 'Inspect a synthetic executor result', scope: 'Only the synthetic executor', completion_criteria: 'The synthetic result has been reviewed',
    state: 'waiting', waiting_for: 'The synthetic result', links: [{ type: 'codex', ref: 'synthetic-mac/thread-1' }] });
  expect(created.work.etag).toBe('1');
  const report = { work_id: id, report_id: 'synthetic-progress-1', kind: 'result', summary: 'Synthetic result ready',
    source: { type: 'codex', ref: 'synthetic-mac/thread-1' } };
  const failed = await first.dispatchFetch('https://synthetic.internal/', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'report', arguments: report, fail_enqueue: true }) });
  expect(failed.status).toBe(500);
  expect(await call(first, 'callbacks')).toEqual([]);
  expect((await call<{ work: Work }>(first, 'get', { work_id: id })).work.last_report_seq).toBe(0);
  const saved = await call<{ report_seq: number }>(first, 'report', report);
  const queued = await call<WorkAttention[]>(first, 'callbacks');
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({ work_id: id, report_seq: saved.report_seq, kind: 'result' });
  expect(JSON.stringify(queued)).not.toContain('Synthetic result ready');
  await first.dispose();
  runtimes.splice(runtimes.indexOf(first), 1);

  const second = await start(persist);
  const restored = await call<{ work: Work; pending_reports: { seq: number }[] }>(second, 'get', { work_id: id });
  expect(restored.work).toMatchObject({ etag: '1', state: 'waiting', last_report_seq: saved.report_seq });
  expect(restored.pending_reports.map(entry => entry.seq)).toEqual([saved.report_seq]);
  expect(await call(second, 'report', report)).toMatchObject({ repeated: true, report_seq: saved.report_seq });
  expect(await call(second, 'callbacks')).toHaveLength(1);
  await call(second, 'checkpoint', { work_id: id, request_id: '00000000-0000-4000-8000-000000000202', etag: '1',
    changes: { state: 'done', result: 'Reviewed the synthetic result' }, handled_through_report_seq: saved.report_seq });
  expect(await call(second, 'context')).toMatchObject({ works: [] });
  expect(await call(second, 'report', { ...report, report_id: 'synthetic-late-progress', summary: 'A late synthetic report' }))
    .toMatchObject({ attention: false });
  expect((await call<{ work: Work }>(second, 'get', { work_id: id })).work.state).toBe('done');
  expect(await call(second, 'callbacks')).toHaveLength(1);
});
