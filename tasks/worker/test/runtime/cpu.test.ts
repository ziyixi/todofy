import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { test, expect } from 'vitest';
import {
  COLD_ISOLATES,
  connectCpuMeter,
  CPU_TEST_TIMEOUT_MS,
  measureInIsolates,
} from '../../../../tools/workerd-cpu/workerd-cpu.mts';
import { localDate } from '@ziyixi/task-dates';
import { betWeeks, LANES, mondayOf } from '../../src/planning.ts';
import { fakeMail, mailEtag } from './fake-mail.ts';
import { seedWorstWeek, WEEK_ENTRIES, WEEK_STEPS } from './focus-week.ts';
import { startHarness } from './harness.ts';

async function syntheticOwner() {
  const generated = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const pair = generated as { publicKey: CryptoKey; privateKey: CryptoKey };
  const publicKey = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as {
    kty: string;
    n: string;
    e: string;
  };
  const encode = (bytes: Uint8Array) =>
    btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', '');
  const segment = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));
  const now = Math.floor(Date.now() / 1000);
  const signed = `${segment({ alg: 'RS256', kid: 'synthetic-key', typ: 'JWT' })}.${segment({ iss: 'https://synthetic.cloudflareaccess.com', aud: ['b'.repeat(64)], email: 'owner@example.test', sub: 'synthetic-owner', iat: now - 1, nbf: now - 1, exp: now + 3600 })}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(signed));
  return {
    jwks: {
      keys: [
        {
          kty: publicKey.kty,
          n: publicKey.n,
          e: publicKey.e,
          kid: 'synthetic-key',
          alg: 'RS256',
          use: 'sig',
        },
      ],
    },
    token: `${signed}.${encode(new Uint8Array(signature))}`,
  };
}

test(
  'annual goals, detailed results and progress keep Worker CPU bounded',
  async () => {
    const owner = await syntheticOwner();
    const result = await measureInIsolates(
      // Five independent cold starts reduce profile variance on this near-budget path. The first request includes
      // Access key import and the catalog's own read and encoding. The isolate's global-scope warm-up (src/startup.ts)
      // has already run the catalog's code over a stub D1, as production's does. No warm-up request or retry.
      5,
      async () => {
        const harness = await startHarness({
          inspectorPort: 0,
          bypass: false,
          jwks: owner.jwks,
          ownerToken: owner.token,
        });
        const long = '合成'.repeat(1000);
        await harness.db
          .prepare(
            `INSERT INTO objectives(id,title,description,year,sort_order,created_at,updated_at)
          SELECT 'cpu-goal-o-'||value,?,?,2030,value,1,1 FROM json_each(?)`,
          )
          .bind('合成'.repeat(150), long, JSON.stringify(Array.from({ length: 20 }, (_, index) => index)))
          .run();
        const milestones = JSON.stringify(
          Array.from({ length: 20 }, (_, index) => ({
            id: `m${String(index)}`,
            title: '合成'.repeat(150),
            completed: true,
            complete_time: '2030-04-15T10:00:00Z',
          })),
        );
        await harness.db
          .prepare(
            `INSERT INTO key_results(id,objective_id,title,floor_text,target_text,notes,milestones,
          focus_start_month,focus_end_month,focus_text,sort_order,created_at,updated_at)
          SELECT 'cpu-goal-kr-'||value,'cpu-goal-o-'||(value%20),?,?,?,?,?,'2030-03','2030-06',?,value,1,1 FROM json_each(?)`,
          )
          .bind(
            '合成'.repeat(150),
            long,
            long,
            long.repeat(4),
            milestones,
            '合成'.repeat(500),
            JSON.stringify(Array.from({ length: 100 }, (_, index) => index)),
          )
          .run();
        await harness.db
          .prepare(
            `INSERT INTO goal_progress(id,key_result_id,note,created_at,updated_at)
          SELECT 'cpu-goal-p-'||value,'cpu-goal-kr-0',?,value,value FROM json_each(?)`,
          )
          .bind(long.repeat(2), JSON.stringify(Array.from({ length: 1000 }, (_, index) => index)))
          .run();
        await harness.db
          .prepare(
            `INSERT INTO tasks(id,title,key_result_id,sort_order,created_at,updated_at)
          SELECT 'cpu-goal-t-'||value,?,'cpu-goal-kr-'||value,value,1,1 FROM json_each(?)`,
          )
          .bind('合成'.repeat(150), JSON.stringify(Array.from({ length: 100 }, (_, index) => index)))
          .run();
        const meter = await connectCpuMeter(harness.mf, 'tasks');
        return {
          harness,
          meter,
          async dispose() {
            meter.close();
            await harness.dispose();
          },
        };
      },
      async ({ harness, meter }) => {
        const read = async (path: string) => {
          const response = await harness.fetch(path);
          const text = await response.text();
          expect(response.status, text.slice(0, 200)).toBe(200);
        };
        return [
          await meter.measure(
            'first authenticated annual goal catalog',
            () => read('/api/tasks/v1/goalCatalog?year=2030'),
            1,
          ),
          await meter.measure(
            '20 Objectives and 100 concise Key Results',
            () => read('/api/tasks/v1/goalCatalog?year=2030'),
            7,
          ),
          await meter.measure(
            'one result with full notes and 20 milestones',
            () => read('/api/tasks/v1/keyResults/cpu-goal-kr-0'),
            7,
          ),
          await meter.measure(
            '50 maximum-length progress notes',
            () => read('/api/tasks/v1/goalProgress?key_result_id=cpu-goal-kr-0&page_size=50'),
            7,
          ),
          await meter.measure(
            '100 tasks with joined short goal references',
            () => read('/api/tasks/v1/tasks?view=all&page_size=100'),
            7,
          ),
        ];
      },
    );
    for (const measurement of result.reference.values()) {
      console.log(JSON.stringify({ event: 'tasks_goals_cpu', ...measurement }));
      expect(measurement.first, measurement.label).toBeLessThan(10);
      if (measurement.label !== 'first authenticated annual goal catalog')
        expect(measurement.median, measurement.label).toBeLessThan(8);
    }
  },
  CPU_TEST_TIMEOUT_MS,
);

test(
  'large description stores keep list responses and Worker CPU bounded',
  async () => {
    const owner = await syntheticOwner();
    const result = await measureInIsolates(
      COLD_ISOLATES,
      async () => {
        const harness = await startHarness({
          inspectorPort: 0,
          bypass: false,
          jwks: owner.jwks,
          ownerToken: owner.token,
        });
        const rows = Array.from({ length: 300 }, (_, index) => ({
          id: `synthetic-${String(index).padStart(4, '0')}`,
          title: `Synthetic task ${String(index)} ` + 'title '.repeat(70),
          order: index,
        }));
        await harness.db
          .prepare(
            `INSERT INTO tasks(id,title,description,sort_order,created_at,updated_at) SELECT value->>'id',value->>'title',?,value->>'order',?,? FROM json_each(?)`,
          )
          .bind('Synthetic long description. '.repeat(550), Date.now(), Date.now(), JSON.stringify(rows))
          .run();
        await harness.db
          .prepare('INSERT INTO tasks(id,title,description,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?)')
          .bind(
            'copy-cpu-root',
            'Synthetic hundred-task template',
            'Synthetic long description. '.repeat(550),
            10000,
            Date.now(),
            Date.now(),
          )
          .run();
        const children = Array.from({ length: 99 }, (_, index) => ({
          id: `copy-cpu-${String(index)}`,
          title: `Template child ${String(index)}`,
        }));
        await harness.db
          .prepare(
            `INSERT INTO tasks(id,title,description,parent_id,sort_order,created_at,updated_at)
            SELECT value->>'id',value->>'title',?,'copy-cpu-root',10000,?,? FROM json_each(?)`,
          )
          .bind('Synthetic long description. '.repeat(550), Date.now(), Date.now(), JSON.stringify(children))
          .run();
        const meter = await connectCpuMeter(harness.mf, 'tasks');
        return {
          harness,
          meter,
          async dispose() {
            meter.close();
            await harness.dispose();
          },
        };
      },
      async ({ harness, meter }) => {
        const read = async (path: string) => {
          const response = await harness.fetch(path);
          const body = await response.text();
          expect(response.status, body.slice(0, 200)).toBe(200);
          expect(new TextEncoder().encode(body).length).toBeLessThan(150000);
        };
        const measurements = [
          await meter.measure(
            'first authenticated task page',
            () => read('/api/tasks/v1/tasks?view=all&page_size=100'),
            1,
          ),
          await meter.measure(
            '100-task page with long descriptions kept in D1',
            () => read('/api/tasks/v1/tasks?view=all&page_size=100'),
            7,
          ),
          await meter.measure('100 current change records', () => read('/api/tasks/v1/changes?page_size=100'), 7),
        ];
        const csrf = await harness.fetch('/api/tasks/csrf');
        const { token } = await csrf.json<{ token: string }>();
        let reorderBatch = 0;
        measurements.push(
          await meter.measure(
            'atomically reorder 100 tasks and answer them without their descriptions',
            async () => {
              const offset = reorderBatch++ * 100;
              const positions = Array.from({ length: 100 }, (_, index) => ({
                name: `tasks/synthetic-${String(offset + 99 - index).padStart(4, '0')}`,
                etag: '1',
                sort_order: offset + index,
              }));
              const response = await harness.fetch('/api/tasks/v1/tasks:reorder', {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  origin: 'https://tasks.example.test',
                  'x-csrf-token': token,
                  cookie: (csrf.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
                },
                body: JSON.stringify({
                  positions,
                  request_id: crypto.randomUUID(),
                }),
              });
              expect(response.status, await response.clone().text()).toBe(200);
              expect((await response.json<{ tasks: unknown[] }>()).tasks).toHaveLength(100);
            },
            3,
          ),
        );
        measurements.push(
          await meter.measure(
            'duplicate 100 active tasks with full stored descriptions',
            async () => {
              const response = await harness.fetch('/api/tasks/v1/tasks/copy-cpu-root:duplicate', {
                method: 'POST',
                headers: {
                  'content-type': 'application/json',
                  origin: 'https://tasks.example.test',
                  'x-csrf-token': token,
                  cookie: (csrf.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
                },
                body: JSON.stringify({
                  etag: '1',
                  request_id: crypto.randomUUID(),
                }),
              });
              const body = await response.text();
              expect(response.status, body.slice(0, 200)).toBe(200);
              expect(JSON.parse(body)).toMatchObject({ child_count: 99 });
            },
            3,
          ),
        );
        return measurements;
      },
    );
    for (const measurement of result.reference.values()) {
      console.log(JSON.stringify({ event: 'tasks_cpu', ...measurement }));
      expect(measurement.first, measurement.label).toBeLessThan(10);
      if (measurement.label !== 'first authenticated task page')
        expect(measurement.median, measurement.label).toBeLessThan(8);
    }
  },
  CPU_TEST_TIMEOUT_MS,
);

const FIRST_WEEK_READ = 'first authenticated read of the fullest Focus week';
test(
  'a cold isolate reads the fullest Focus week within the first-request bound',
  async () => {
    const owner = await syntheticOwner();
    const result = await measureInIsolates(
      COLD_ISOLATES,
      async () => {
        const harness = await startHarness({
          inspectorPort: 0,
          bypass: false,
          jwks: owner.jwks,
          ownerToken: owner.token,
        });
        await seedWorstWeek(harness.db, '2030-04-15');
        const meter = await connectCpuMeter(harness.mf, 'tasks');
        return {
          harness,
          meter,
          async dispose() {
            meter.close();
            await harness.dispose();
          },
        };
      },
      async ({ harness, meter }) => {
        const read = async () => {
          const response = await harness.fetch('/api/tasks/v1/focusDays?start_day=2030-04-15&end_day=2030-04-21');
          const body = await response.text();
          expect(response.status, body.slice(0, 200)).toBe(200);
          expect((JSON.parse(body) as { tasks: unknown[] }).tasks).toHaveLength(WEEK_STEPS + WEEK_ENTRIES);
        };
        return [
          await meter.measure(FIRST_WEEK_READ, read, 1),
          await meter.measure('the fullest Focus week: 140 steps, 210 records, 350 tasks', read, 7),
        ];
      },
    );
    for (const measurement of result.reference.values())
      console.log(JSON.stringify({ event: 'tasks_cpu', ...measurement }));
    for (const measurement of result.reference.values()) {
      expect(measurement.first, measurement.label).toBeLessThan(10);
      if (measurement.label !== FIRST_WEEK_READ) expect(measurement.median, measurement.label).toBeLessThan(8);
    }
  },
  CPU_TEST_TIMEOUT_MS,
);

/**
 * Planning's worst reads and its dependency write: a page of 100 tasks with long titles and every planning flag, 60
 * of them waiting for 5 of the others (the 300 dependencies a store keeps at most, each with its prerequisite's
 * title), the fullest plan (6 Bets of 160 characters, 7 lanes of 100 tasks and 100 next-week choices), then a
 * dependency added and removed among 300.
 */
const FIRST_PLANNING_PAGE = 'first authenticated page of planned tasks';
async function seedPlanning(db: D1Database) {
  const flags = JSON.stringify(['quick', 'waiting', 'parked', 'active', 'onhold', 'routine', 'task']);
  const tasks = Array.from({ length: 100 }, (_, index) => ({
    id: index < 60 ? `waiter-${String(index).padStart(3, '0')}` : `prerequisite-${String(index - 60).padStart(3, '0')}`,
    title: `Synthetic planned task ${String(index)} ` + 'title '.repeat(70),
    order: index,
  }));
  await db
    .prepare(
      `INSERT INTO tasks(id,title,sort_order,deadline,stage,committed_week,area,lead_days,planning_flags,created_at,updated_at)
      SELECT value->>'id',value->>'title',value->>'order','2099-01-09','committed','2099-01-05','work',3,?,1,1 FROM json_each(?)`,
    )
    .bind(flags, JSON.stringify(tasks))
    .run();
  const edges = Array.from({ length: 300 }, (_, index) => ({
    task: `waiter-${String(Math.floor(index / 5)).padStart(3, '0')}`,
    prerequisite: `prerequisite-${String((Math.floor(index / 5) + (index % 5)) % 40).padStart(3, '0')}`,
  }));
  await db
    .prepare(
      `INSERT INTO task_dependencies(task_id,prerequisite_id,created_at,updated_at)
      SELECT value->>'task',value->>'prerequisite',key,key FROM json_each(?)`,
    )
    .bind(JSON.stringify(edges))
    .run();
  const week = mondayOf(localDate(Date.now(), 'America/Los_Angeles'));
  await db
    .prepare(
      `INSERT INTO weekly_bets(week_start,area,text,created_at,updated_at)
      SELECT w.value,a.value,?,1,1 FROM json_each(?) w, json_each('["work","personal"]') a`,
    )
    .bind('目标'.repeat(80), JSON.stringify(betWeeks(week)))
    .run();
  const lanes = Object.fromEntries(LANES.map((lane) => [lane, tasks.map((task) => task.id)]));
  await db.prepare("UPDATE plan_board SET lanes=? WHERE id='board'").bind(JSON.stringify(lanes)).run();
}

test(
  "planning's fullest reads and a dependency write stay within the request bounds",
  async () => {
    const owner = await syntheticOwner();
    const result = await measureInIsolates(
      COLD_ISOLATES,
      async () => {
        const harness = await startHarness({
          inspectorPort: 0,
          bypass: false,
          jwks: owner.jwks,
          ownerToken: owner.token,
        });
        await seedPlanning(harness.db);
        const meter = await connectCpuMeter(harness.mf, 'tasks');
        return {
          harness,
          meter,
          async dispose() {
            meter.close();
            await harness.dispose();
          },
        };
      },
      async ({ harness, meter }) => {
        const read = async (path: string, check: (body: string) => void) => {
          const response = await harness.fetch(path);
          const body = await response.text();
          expect(response.status, body.slice(0, 200)).toBe(200);
          check(body);
        };
        const page = () =>
          read('/api/tasks/v1/tasks?view=all&page_size=100', (body) => {
            const tasks = (JSON.parse(body) as { tasks: { dependencies?: unknown[] }[] }).tasks;
            expect(tasks.map((task) => task.dependencies?.length ?? 0)).toEqual(
              Array.from({ length: 100 }, (_, index) => (index < 60 ? 5 : 0)),
            );
          });
        const plan = () =>
          read('/api/tasks/v1/plan', (body) => {
            const answer = JSON.parse(body) as {
              weekly_bets: unknown[];
              lane_orders: unknown[];
              next_week_task_ids: unknown[];
            };
            expect([answer.weekly_bets.length, answer.lane_orders.length, answer.next_week_task_ids.length]).toEqual([
              6, 7, 100,
            ]);
          });
        const measurements = [
          await meter.measure(FIRST_PLANNING_PAGE, page, 1),
          await meter.measure('100 tasks with every planning flag, 60 of them waiting for 5', page, 7),
          await meter.measure('the fullest plan: 6 Bets, 7 lanes of 100 and 100 next-week choices', plan, 7),
        ];
        // 299 dependencies remain: the first waiter waits for one less.
        await harness.db
          .prepare(
            "UPDATE task_dependencies SET deleted_at=1 WHERE task_id='waiter-000' AND prerequisite_id='prerequisite-004'",
          )
          .run();
        const csrf = await harness.fetch('/api/tasks/csrf');
        const { token } = await csrf.json<{ token: string }>();
        let etag = '1';
        let writes = 0;
        measurements.push(
          await meter.measure(
            'add or remove a dependency among 300, through the waiting chain it checks',
            async () => {
              const wanted = writes++ % 2 === 0 ? [{ prerequisite_id: 'waiter-000' }] : [];
              const response = await harness.fetch(
                `/api/tasks/v1/tasks/prerequisite-039?etag=${etag}&request_id=${crypto.randomUUID()}&update_mask=dependencies`,
                {
                  method: 'PATCH',
                  headers: {
                    'content-type': 'application/json',
                    origin: 'https://tasks.example.test',
                    'x-csrf-token': token,
                    cookie: (csrf.headers.get('set-cookie') ?? '').split(';')[0] ?? '',
                  },
                  body: JSON.stringify({
                    name: 'tasks/prerequisite-039',
                    dependencies: wanted,
                  }),
                },
              );
              const body = await response.text();
              expect(response.status, body.slice(0, 200)).toBe(200);
              const task = JSON.parse(body) as {
                etag: string;
                dependencies?: unknown[];
              };
              expect(task.dependencies ?? []).toHaveLength(wanted.length);
              etag = task.etag;
            },
            7,
          ),
        );
        return measurements;
      },
    );
    for (const measurement of result.reference.values())
      console.log(JSON.stringify({ event: 'tasks_cpu', ...measurement }));
    for (const measurement of result.reference.values()) {
      expect(measurement.first, measurement.label).toBeLessThan(10);
      if (measurement.label !== FIRST_PLANNING_PAGE) expect(measurement.median, measurement.label).toBeLessThan(8);
    }
  },
  CPU_TEST_TIMEOUT_MS,
);

/**
 * The isolate's one-time start (src/startup.ts): the global scope's warm-up, run here in a request so the meter sees
 * it, in an isolate whose first request did nothing else. Its first run is what a fresh isolate's start costs: about
 * 11 reference ms of first Intl initialization and 9 of warming the task page's and the Focus week's code and codec
 * (2026-10-20). No request these tests measure reaches 10 reference ms even as an isolate's first request (above and
 * below), so a CPU p99 near 20 ms in production matches isolates' starts, not a heavy request. Startup has its own
 * limit (1 s), not Free's 10 ms; the bound keeps the warm-up from growing unnoticed.
 */
const FIRST_WARM_UP = 'the startup warm-up, on its first run in an isolate';
test(
  'an isolate starts within its warm-up bound',
  async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const bundled = await build({
      stdin: {
        contents: `import { warmUp } from './src/startup.ts';
          export default { async fetch(request) { if (new URL(request.url).pathname === '/warm') await warmUp('US/Pacific'); return new Response(null, { status: 204 }); } };`,
        resolveDir: root,
        sourcefile: 'warm-up-probe.ts',
        loader: 'ts',
      },
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2024',
      mainFields: ['module', 'main'],
      conditions: ['workerd', 'worker', 'import'],
      external: ['cloudflare:workers'],
      write: false,
      logLevel: 'silent',
    });
    const script = bundled.outputFiles[0]?.text ?? '';
    const result = await measureInIsolates(
      COLD_ISOLATES,
      async () => {
        const mf = new Miniflare(
          convertV4MiniflareOptions({
            host: '127.0.0.1',
            port: 0,
            inspectorPort: 0,
            workers: [
              {
                name: 'warm-up',
                modules: true,
                script,
                compatibilityDate: '2026-09-08',
              },
            ],
          }),
        );
        await mf.ready;
        const meter = await connectCpuMeter(mf, 'warm-up');
        return {
          mf,
          meter,
          async dispose() {
            meter.close();
            await mf.dispose();
          },
        };
      },
      async ({ mf, meter }) => {
        const call = async (path: string) => {
          const response = await mf.dispatchFetch(`http://warm-up.test${path}`);
          expect(response.status).toBe(204);
        };
        return [
          await meter.measure('a request that does nothing, first in its isolate', () => call('/'), 1),
          await meter.measure(FIRST_WARM_UP, () => call('/warm'), 1),
        ];
      },
    );
    for (const measurement of result.reference.values())
      console.log(JSON.stringify({ event: 'tasks_cpu', ...measurement }));
    expect(result.reference.get(FIRST_WARM_UP)?.first).toBeLessThan(30);
  },
  CPU_TEST_TIMEOUT_MS,
);

/**
 * What other Workers call: Home's Ops.status() as an isolate's very first request, and reads through a TasksApi
 * binding: a search of 20 tasks with full 16,000-character descriptions (the Personal MCP's) and a page of 100. And a
 * mail conversion, which reads a 64 KiB summary from Todofy's Mail entry, cuts it to 16,000 UTF-16
 * units, creates the task and marks the mail; and TaskInbox's largest create, a task of 16,000 units with 30 subtasks
 * of as many.
 */
const FIRST_OPS_STATUS = "Home's Ops.status() as an isolate's first request";
test(
  "Home's status and the bindings' calls stay within the request bounds",
  async () => {
    const result = await measureInIsolates(
      COLD_ISOLATES,
      async () => {
        const todofy = fakeMail(
          Array.from({ length: 12 }, (_, index) => ({
            id: `cpu-mail-${String(index)}`,
            title: 'Synthetic CPU mail',
            summary: '汉'.repeat(21845),
          })),
        );
        const harness = await startHarness({
          inspectorPort: 0,
          mail: todofy.handle,
        });
        // The owner's CSRF token, fetched before the meter connects.
        expect((await harness.mutate('GET', '/api/tasks/v1/mailCategories')).status).toBe(200);
        const rows = Array.from({ length: 100 }, (_, index) => ({
          id: `service-${String(index).padStart(3, '0')}`,
        }));
        await harness.db
          .prepare(
            `INSERT INTO tasks(id,title,description,sort_order,created_at,updated_at) SELECT value->>'id','Synthetic mail task',?,key,?,? FROM json_each(?)`,
          )
          .bind(
            'Synthetic mail "body" 汉字\n'.repeat(800).slice(0, 15900) + ' footer-synthetic',
            Date.now(),
            Date.now(),
            JSON.stringify(rows),
          )
          .run();
        const meter = await connectCpuMeter(harness.mf, 'tasks');
        return {
          harness,
          todofy,
          meter,
          async dispose() {
            meter.close();
            await harness.dispose();
          },
        };
      },
      async ({ harness, todofy, meter }) => {
        const ops = await harness.mf.getWorker('tasks-ops');
        const inbox = await harness.mf.getWorker('tasks-inbox-home');
        const long = 'Synthetic digest line 汉字\n'.repeat(800).slice(0, 16000);
        const binding = await harness.mf.getWorker('tasks-read-write');
        const status = async () => {
          const answer = (await (await ops.fetch('https://tasks.internal/status')).json()) as { health: string };
          expect(answer.health).toBe('ok');
        };
        const list = async (query: string, count: number) => {
          const response = await binding.fetch(`https://tasks.internal/api/tasks/v1/tasks?${query}`);
          expect(response.status, (await response.clone().text()).slice(0, 200)).toBe(200);
          expect(((await response.json()) as { tasks: unknown[] }).tasks).toHaveLength(count);
        };
        return [
          await meter.measure(FIRST_OPS_STATUS, status, 1),
          await meter.measure("Home's Ops.status()", status, 7),
          await meter.measure(
            'a footer search: 20 tasks with full 16,000-character descriptions',
            () => list('view=search&query=footer-synthetic&page_size=20&include_description=true', 20),
            7,
          ),
          await meter.measure('a service page of 100 tasks', () => list('view=all&page_size=100', 100), 7),
          await meter.measure(
            'convert a mail whose summary is 64 KiB',
            async () => {
              const mail = todofy.mail.find((item) => item.pending !== false);
              if (!mail) throw new Error('no synthetic mail left');
              const response = await harness.mutate('POST', '/api/tasks/v1/mailItems:convert', {
                event_id: mail.id,
                etag: mailEtag(mail),
                request_id: crypto.randomUUID(),
              });
              expect(response.status, (await response.clone().text()).slice(0, 200)).toBe(200);
              expect(mail.pending).toBe(false);
            },
            7,
          ),
          await meter.measure(
            'TaskInbox: a task with 30 subtasks, each 16,000 units long',
            async () => {
              const response = await inbox.fetch('https://inbox.internal/', {
                method: 'POST',
                body: JSON.stringify({
                  request_id: crypto.randomUUID(),
                  title: 'Synthetic CPU digest',
                  description: long,
                  subtasks: Array.from({ length: 30 }, (_, index) => ({
                    title: `Item ${String(index)}`,
                    description: long,
                  })),
                }),
              });
              const answer = (await response.json()) as {
                subtask_ids?: string[];
                error?: string;
              };
              expect(answer.error).toBeUndefined();
              expect(answer.subtask_ids).toHaveLength(30);
            },
            7,
          ),
        ];
      },
    );
    for (const measurement of result.reference.values())
      console.log(JSON.stringify({ event: 'tasks_cpu', ...measurement }));
    for (const measurement of result.reference.values()) {
      expect(measurement.first, measurement.label).toBeLessThan(10);
      if (measurement.label !== FIRST_OPS_STATUS) expect(measurement.median, measurement.label).toBeLessThan(8);
    }
  },
  CPU_TEST_TIMEOUT_MS,
);

test(
  'GTD reports keep a full month and bounded long-title contexts within Worker CPU',
  async () => {
    const owner = await syntheticOwner();
    const result = await measureInIsolates(
      COLD_ISOLATES,
      async () => {
        const harness = await startHarness({
          inspectorPort: 0,
          bypass: false,
          jwks: owner.jwks,
          ownerToken: owner.token,
        });
        const ids = Array.from({ length: 100 }, (_, index) => index);
        const rows = Array.from({ length: 31 * 30 }, (_, index) => ({
          id: index,
          task: index % 100,
          day: `2030-10-${String(1 + Math.floor(index / 30)).padStart(2, '0')}`,
        }));
        await harness.db
          .prepare(
            "INSERT INTO tasks(id,title,duration_minutes,area,created_at,updated_at) VALUES('report-parent',?,120,'work',1,1)",
          )
          .bind('合成'.repeat(250))
          .run();
        await harness.db
          .prepare(
            `INSERT INTO tasks(id,title,parent_id,kind,area,duration_minutes,created_at,updated_at)
        SELECT 'report-task-'||value,?,'report-parent','step','unassigned',30,1,1 FROM json_each(?)`,
          )
          .bind('合成'.repeat(250), JSON.stringify(ids))
          .run();
        await harness.db
          .prepare(
            `INSERT INTO focus_entries(id,task_id,day,seconds,source,area,created_at,updated_at)
        SELECT 'report-entry-'||(value->>'id'),'report-task-'||(value->>'task'),value->>'day',1800,'manual','work',1,1 FROM json_each(?)`,
          )
          .bind(JSON.stringify(rows))
          .run();
        await harness.db
          .prepare(
            `INSERT INTO completions(id,task_id,title,completed_at)
        SELECT 'report-completion-'||value,'report-task-'||value,'Synthetic completion',1918324800000 FROM json_each(?)`,
          )
          .bind(JSON.stringify(ids))
          .run();
        const meter = await connectCpuMeter(harness.mf, 'tasks');
        return {
          harness,
          meter,
          async dispose() {
            meter.close();
            await harness.dispose();
          },
        };
      },
      async ({ harness, meter }) => {
        const read = async (area = '') => {
          const response = await harness.fetch(`/api/tasks/v1/gtdReport?start_day=2030-10-01&end_day=2030-10-31&area=${area}`);
          const text = await response.text();
          expect(response.status, text.slice(0, 200)).toBe(200);
          const report = JSON.parse(text) as { tasks: unknown[]; recorded_seconds: number };
          expect(report.tasks).toHaveLength(100);
          expect(report.recorded_seconds).toBe(31 * 30 * 1800);
        };
        return [
          await meter.measure('first authenticated GTD month', read, 1),
          await meter.measure('GTD month with 100 long task contexts', read, 7),
          await meter.measure('GTD month filtered by inherited work area', () => read('work'), 7),
        ];
      },
    );
    for (const measurement of result.reference.values()) {
      console.log(JSON.stringify({ event: 'tasks_gtd_report_cpu', ...measurement }));
      expect(measurement.first, measurement.label).toBeLessThan(10);
      if (measurement.label !== 'first authenticated GTD month')
        expect(measurement.median, measurement.label).toBeLessThan(8);
    }
  },
  CPU_TEST_TIMEOUT_MS,
);
