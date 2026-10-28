/**
 * docs/backup.md rehearsed on the real Worker in workerd: a store filled through MCP gets its first backup from Home's
 * status once the bucket is bound; tools/backup-restore.ts downloads and verifies it with wrangler and uploads it into
 * a new environment's bucket; there the owner's call restores it into the new, empty store, which refuses MCP and
 * reports maintenance until it is done, then serves the same Work, re-baselines its business source without replaying
 * it, replays the Watch feed from its restored cursor and backs itself up. Synthetic sources and receivers only.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Webhook } from 'standardwebhooks';
import { afterEach, expect, it } from 'vitest';
import { create } from '@ziyixi/proto/protobuf';
import { toWire } from '@ziyixi/proto/wire-json';
import type { ReadHomeResponse } from '@ziyixi/proto/dashboard/mcp/v1/home_service_wire';
import { TaskSchema } from '@ziyixi/proto/tasks/ui/v1/task_pb';
import { ListChangesResponseSchema, TaskChangeSchema, type TaskChange } from '@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb';

const TOOL = join(import.meta.dirname, '../../../tools/backup-restore.ts');
const secret = `whsec_${btoa('s'.repeat(32))}`;
const callback = { mode: 'webhook', url: 'https://receiver.example.org/callback', secret };
const runtimes: Miniflare[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

/** Tasks and Watch as their private bindings answer, with heads the test moves; Home quiet. */
function sources() {
  let taskHead = 10;
  const changes: TaskChange[] = [];
  let watchHead = 40;
  const watchEvents: { sequence: number; watch: string }[] = [];
  const reads = { taskBaselines: 0, taskCursors: [] as string[], watchBaselines: 0, watchCursors: [] as string[] };
  return {
    reads,
    advanceTasks() {
      const task = create(TaskSchema, { name: 'tasks/external', id: 'external', etag: '2' });
      changes.push(create(TaskChangeSchema, { cursor: String(++taskHead), name: task.name, task }));
    },
    advanceWatch(watch: string) { watchEvents.push({ sequence: ++watchHead, watch }); },
    tasks: async (request: Request) => {
      const url = new URL(request.url);
      if (request.method === 'POST') {
        const id = url.searchParams.get('task_id') ?? '';
        const body = await request.json<Record<string, unknown>>();
        return Response.json({ name: `tasks/${id}`, id, etag: '1', title: body.title, ...(body.parent_id ? { kind: 'step', parent_id: body.parent_id } : {}) });
      }
      expect(url.pathname).toBe('/api/tasks/v1/changes');
      if (url.searchParams.get('baseline') === 'true') {
        reads.taskBaselines++;
        return Response.json(toWire(ListChangesResponseSchema, create(ListChangesResponseSchema, { nextPageToken: String(taskHead) })));
      }
      const cursor = url.searchParams.get('page_token') ?? '';
      reads.taskCursors.push(cursor);
      return Response.json(toWire(ListChangesResponseSchema, create(ListChangesResponseSchema, {
        nextPageToken: String(taskHead), changes: changes.filter(change => Number(change.cursor) > Number(cursor)) })));
    },
    watch: (request: Request) => {
      const url = new URL(request.url);
      expect(url.pathname).toBe('/api/v1/watchEvents:poll');
      if (url.searchParams.get('baseline') === 'true') {
        reads.watchBaselines++;
        return Response.json({ cursor: String(watchHead) });
      }
      const cursor = Number(url.searchParams.get('cursor'));
      reads.watchCursors.push(String(cursor));
      const events = watchEvents.filter(event => event.sequence > cursor).map(event => ({ sequence: String(event.sequence),
        kind: 'evidence_changed', watch: event.watch, before_snapshot: `${event.watch}/snapshots/${String(event.sequence - 1).padStart(16, '0')}`,
        after_snapshot: `${event.watch}/snapshots/${String(event.sequence).padStart(16, '0')}`, create_time: '2026-10-27T12:00:00Z' }));
      return Response.json({ cursor: String(watchHead), events });
    },
  };
}
type Sources = ReturnType<typeof sources>;

async function start(root: string, received: unknown[], fixture: Sources, backups: boolean) {
  const bundle = await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'browser',
    conditions: ['workerd', 'worker', 'browser'], target: 'es2024', external: ['cloudflare:workers', 'node:*'], write: false, logLevel: 'silent' });
  const output = bundle.outputFiles[0];
  if (!output) throw new Error('No bundled Worker');
  const home: ReadHomeResponse = { generated_at: '2026-10-27T12:00:00Z', build: 'synthetic', rev: 1,
    refresh: { last_tick_at: '2026-10-27T12:00:00Z', next_tick_at: '2026-10-27T12:00:00Z', last_refresh_at: null,
      next_refresh_at: '2026-10-27T12:00:00Z', refreshed: false }, entries: [], attention: [], head_seq: 0, control_unavailable_count: 0 };
  const mf = new Miniflare(convertV4MiniflareOptions({
    // wrangler's own layout, so `--local --persist-to <root>` reads and writes the same bucket.
    resourcePersistencePath: join(root, 'v3'),
    workers: [{
      name: 'personal-mcp', script: output.text, modules: true, compatibilityDate: '2026-09-08', compatibilityFlags: ['nodejs_compat'],
      durableObjects: { SUBSCRIPTIONS: { className: 'SubscriptionStore', useSQLite: true } },
      ...(backups ? { r2Buckets: { BACKUPS: 'personal-mcp-backups' } } : {}),
      serviceBindings: { TASKS: fixture.tasks, WATCH: fixture.watch, TODOFY_MAIL: () => new Response(null, { status: 503 }),
        RECALL: () => new Response(null, { status: 503 }), HOME: { name: 'home-fixture', entrypoint: 'HomeApi' } },
      bindings: { PUBLIC_HOST: 'mcp.example.org', ACCESS_ISSUER: 'https://test.cloudflareaccess.com', ACCESS_AUDIENCE: 'test',
        ACCESS_OWNER: 'owner@example.org', DEV_AUTH_BYPASS: 'true', BUILD_SHA: 'a'.repeat(40), CALLBACK_HOSTS: 'receiver.example.org' },
      outboundService: async (request: Request) => {
        const body = await request.text();
        const verified = new Webhook(secret).verify(body, Object.fromEntries(request.headers)) as Record<string, unknown>;
        if (verified.type === 'verification') return Response.json({ challenge: verified.challenge });
        received.push(verified);
        return new Response(null, { status: 204 });
      },
    }, {
      name: 'ops-probe', modules: true, compatibilityDate: '2026-09-08',
      script: 'export default { async fetch(request, env) { return Response.json(await env.OPS.status()); } }',
      serviceBindings: { OPS: { name: 'personal-mcp', entrypoint: 'Ops' } },
    }, {
      name: 'home-fixture', modules: true, compatibilityDate: '2026-09-08',
      script: `import { WorkerEntrypoint } from 'cloudflare:workers';
        export class HomeApi extends WorkerEntrypoint { readHome() { return ${JSON.stringify(home)}; } }
        export default { fetch() { return new Response(null, { status: 404 }); } };`,
    }],
  }));
  runtimes.push(mf);
  await mf.ready;
  return mf;
}

async function stop(mf: Miniflare) {
  runtimes.splice(runtimes.indexOf(mf), 1);
  await mf.dispose();
}

async function rpc(mf: Miniflare, method: string, params: Record<string, unknown> = {}): Promise<{ status: number; result: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method };
  if (method === 'tools/call') headers['Mcp-Name'] = String(params.name);
  const response = await mf.dispatchFetch('http://127.0.0.1/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method,
    params: { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'synthetic-test', version: '1.0.0' } } } }) });
  if (response.status !== 200) return { status: response.status, result: await response.json() };
  const reply = await response.json() as { result: unknown; error?: unknown };
  expect(reply.error, method).toBeUndefined();
  return { status: 200, result: reply.result };
}

async function tool<T>(mf: Miniflare, name: string, args: Record<string, unknown>): Promise<T> {
  const { status, result: reply } = await rpc(mf, 'tools/call', { name, arguments: args });
  const result = reply as { isError?: boolean; structuredContent: T };
  expect(status, name).toBe(200);
  expect(result.isError, name).not.toBe(true);
  return result.structuredContent;
}

type Restore = { backup: { status: string; last_key: string } | null;
  restore: { phase: string; error_code: string; verification: { name: string; expected: number; restored: number; ok: boolean }[] | null } | null };
function owner(mf: Miniflare, method = 'GET', body?: unknown, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  return mf.dispatchFetch('http://127.0.0.1/owner/restore', { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function ops(mf: Miniflare) {
  const probe = await mf.getWorker('ops-probe');
  return await (await probe.fetch('https://ops.internal/')).json() as { health: string; modes: { maintenance: boolean };
    counters: Record<string, number>; signals: { code: string }[]; last_backup_at: string | null };
}

function run(...args: string[]) {
  return spawnSync('node', [TOOL, ...args], { encoding: 'utf8' });
}

it('backs a filled store up, restores it through the owner call into a new environment and resumes its work', async () => {
  const rootA = await mkdtemp(join(tmpdir(), 'personal-mcp-backup-a-'));
  const rootB = await mkdtemp(join(tmpdir(), 'personal-mcp-backup-b-'));
  const work = await mkdtemp(join(tmpdir(), 'personal-mcp-restore-'));
  directories.push(rootA, rootB, work);
  const received: unknown[] = [];
  const fixture = sources();
  const watched = 'watches/synthetic-restore';
  const workId = '00000000-0000-4000-8000-000000000301';

  // Before the release that binds the bucket: a store with every kind of record, made through MCP.
  const first = await start(rootA, received, fixture, false);
  for (const [name, args] of [['personal_cloud.test', {}], ['task.changed', {}], ['work.attention', {}]] as const)
    await rpc(first, 'events/subscribe', { name, arguments: args, delivery: callback, ttlMs: null, cursor: null });
  await tool(first, 'work_create', { request_id: workId, title: 'Synthetic restored work', goal: 'Keep a synthetic goal',
    scope: 'Synthetic only', completion_criteria: 'The synthetic check passes', next_action: 'Read the synthetic source',
    links: [{ type: 'watch', ref: watched }, { type: 'codex', ref: 'codex://threads/synthetic' }] });
  await tool(first, 'work_report', { work_id: workId, report_id: 'synthetic-report', kind: 'progress', summary: 'Synthetic progress',
    source: { type: 'codex', ref: 'codex://threads/synthetic' } });
  await tool(first, 'work_checkpoint', { work_id: workId, request_id: crypto.randomUUID(), etag: '1',
    changes: { checkpoint: 'Synthetic checkpoint 汉字 “quoted”' } });
  await tool(first, 'tasks_create_inbox', { request_id: '00000000-0000-4000-8000-000000000302', title: 'Synthetic inbox task' });
  await tool(first, 'tasks_add_steps', { request_id: '00000000-0000-4000-8000-000000000303', task_id: 'synthetic-parent',
    steps: [{ title: 'Synthetic step' }] });
  await tool(first, 'send_test_event', { request_id: '00000000-0000-4000-8000-000000000304' });
  await expect.poll(() => received.length, { timeout: 15_000 }).toBe(2);
  const before = await tool<Record<string, unknown>>(first, 'work_get', { work_id: workId });
  const status = await tool<{ status: { subscriptions: number; deliveries: Record<string, number> } }>(first, 'connection_status', {});
  expect(status.status).toMatchObject({ subscriptions: 3, deliveries: { accepted: 2 } });
  await stop(first);

  // The release that binds it: Home's status starts the first backup at once.
  const second = await start(rootA, received, fixture, true);
  await expect.poll(async () => (await ops(second)).last_backup_at, { timeout: 20_000, interval: 250 }).not.toBeNull();
  const backedUp = await ops(second);
  expect(backedUp.counters.backup_age_seconds).toBeGreaterThanOrEqual(0);
  expect(backedUp.signals).toEqual([]);
  const view = await (await owner(second)).json() as Restore;
  expect(view).toMatchObject({ backup: { status: 'ok' }, restore: null });
  const prefix = view.backup?.last_key ?? '';
  await stop(second);

  // docs/backup.md: download and verify the newest backup, then upload it into the new environment's bucket.
  const copy = join(work, 'restore');
  const downloaded = run('download', '--out', copy, '--local', '--persist-to', rootA);
  expect(downloaded.status, downloaded.stderr).toBe(0);
  expect(downloaded.stdout).toContain(`backup ${prefix}\n`);
  expect(downloaded.stdout).toMatch(/\nPASS work_entries rows=3 parts=1\n[^]*\nPASS kv rows=3 parts=1\ndownload PASS\n$/);
  const verified = run('verify', '--in', copy);
  expect(verified.status, verified.stderr).toBe(0);
  expect(verified.stdout).toContain('PASS subscriptions rows=3\n');
  const uploaded = run('upload', '--in', copy, '--local', '--persist-to', rootB);
  expect(uploaded.status, uploaded.stderr).toBe(0);
  expect(run('upload', '--in', copy, '--local', '--persist-to', rootB).stderr).toMatch(/already holds .* complete/);

  // What changed after the backup: a task change (not replayed) and a Watch change (replayed from the cursor).
  fixture.advanceTasks();
  fixture.advanceWatch(watched);
  const baselines = structuredClone(fixture.reads);
  const restoredAt = received.length;
  const target = await start(rootB, received, fixture, true);
  // Hold one part back, so the restore stays unfinished long enough to look at.
  const bucket = await target.getR2Bucket('BACKUPS');
  const manifest = JSON.parse(await readFile(join(copy, 'manifest.json'), 'utf8')) as { tables: { name: string; parts: { key: string }[] }[] };
  const held = manifest.tables.find(table => table.name === 'work_entries')?.parts[0]?.key ?? '';
  await bucket.delete(held);

  expect((await owner(target, 'POST', { backup: prefix }, {})).status).toBe(415);
  const foreign = await target.dispatchFetch('https://mcp.example.org/owner/restore', { method: 'POST', body: JSON.stringify({ backup: prefix }),
    headers: { 'content-type': 'application/json', origin: 'https://elsewhere.example' } });
  expect(foreign.status).toBe(403);
  expect(await (await owner(target, 'POST', { backup: 'latest' })).json()).toMatchObject({ error: 'invalid_backup' });
  const started = await owner(target, 'POST', { backup: prefix });
  expect(started.status).toBe(202);
  await expect.poll(async () => ((await (await owner(target)).json()) as Restore).restore?.error_code, { timeout: 10_000 }).toBe('part_missing');
  expect(await rpc(target, 'tools/call', { name: 'connection_status', arguments: {} })).toMatchObject({ status: 503, result: { error: 'restore_unfinished' } });
  expect(await ops(target)).toMatchObject({ health: 'down', modes: { maintenance: true } });
  await bucket.put(held, await readFile(join(copy, 'parts', held)));
  expect((await owner(target, 'POST', { backup: prefix })).status).toBe(202);
  await expect.poll(async () => ((await (await owner(target)).json()) as Restore).restore?.phase, { timeout: 10_000 }).toBe('done');
  const restored = await (await owner(target)).json() as Restore;
  expect(restored.restore?.verification?.every(item => item.ok)).toBe(true);
  expect(restored.restore?.verification?.find(item => item.name === 'work_entries')).toMatchObject({ expected: 3, restored: 3 });

  // The same Work, plus the Watch change replayed once from the restored cursor; the task feed takes a new baseline.
  await expect.poll(() => received.length, { timeout: 15_000 }).toBe(restoredAt + 1);
  expect(received.at(-1)).toMatchObject({ name: 'work.attention', data: { work_id: workId, source: { type: 'watch', ref: watched } } });
  const after = await tool<{ work: Record<string, unknown>; entries: unknown[]; pending_reports: { report_id: string }[] }>(target, 'work_get', { work_id: workId });
  const earlier = before as { work: Record<string, unknown>; entries: unknown[]; pending_reports: { report_id: string }[] };
  expect(after.entries.slice(1)).toEqual(earlier.entries);
  expect(after.pending_reports.map(report => report.report_id)).toEqual(['synthetic-report', 'watch:41']);
  expect({ ...after.work, last_report_seq: 0, updated_at: '' }).toEqual({ ...earlier.work, last_report_seq: 0, updated_at: '' });
  expect(fixture.reads.taskBaselines).toBe(baselines.taskBaselines + 1);
  expect(fixture.reads.taskCursors).toEqual(baselines.taskCursors);
  expect(fixture.reads.watchCursors).toEqual([...baselines.watchCursors, '40']);
  expect(fixture.reads.watchBaselines).toBe(baselines.watchBaselines);
  const resumed = await tool<{ status: { subscriptions: number; deliveries: Record<string, number>; sources: { name: string; error_code: string | null }[] } }>(target, 'connection_status', {});
  expect(resumed.status.subscriptions).toBe(3);
  expect(resumed.status.sources.map(source => [source.name, source.error_code])).toEqual([['task.changed', null], ['work.watch', null]]);
  // Then the restored store backs itself up, and Home sees it healthy.
  await expect.poll(async () => ((await (await owner(target)).json()) as Restore).backup?.last_key, { timeout: 20_000, interval: 250 })
    .not.toBe(prefix);
  expect(await ops(target)).toMatchObject({ health: 'ok', modes: { maintenance: false } });
}, 120_000);
