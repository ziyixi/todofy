import { test, expect } from 'vitest';
import {
  COLD_ISOLATES,
  connectCpuMeter,
  CPU_TEST_TIMEOUT_MS,
  measureInIsolates,
} from '../../../../tools/workerd-cpu/workerd-cpu.mts';
import { seedWorstWeek, WEEK_ENTRIES, WEEK_STEPS } from './focus-week.ts';
import { startHarness } from './harness.ts';

async function syntheticOwner() {
  const generated = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pair = generated as { publicKey: CryptoKey; privateKey: CryptoKey };
  const publicKey = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as { kty: string; n: string; e: string };
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
      keys: [{ kty: publicKey.kty, n: publicKey.n, e: publicKey.e, kid: 'synthetic-key', alg: 'RS256', use: 'sig' }],
    },
    token: `${signed}.${encode(new Uint8Array(signature))}`,
  };
}

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
          .prepare(
            'INSERT INTO tasks(id,title,description,sort_order,created_at,updated_at) VALUES(?,?,?,?,?,?)',
          )
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
        // The backup export's worst pages: 100 tasks of 48 KB (CJK) descriptions, and 100 receipts of a full task each.
        const wide = Array.from({ length: 100 }, (_, index) => ({ id: `backup-cpu-${String(index)}` }));
        await harness.db
          .prepare(
            `INSERT INTO tasks(id,title,description,sort_order,created_at,updated_at) SELECT value->>'id','Synthetic backup task',?,20000,?,? FROM json_each(?)`,
          )
          .bind('汉字'.repeat(8000), Date.now(), Date.now(), JSON.stringify(wide))
          .run();
        await harness.db
          .prepare(
            `INSERT INTO requests(id,fingerprint,response,created_at,revision_guard) SELECT printf('00000000-0000-4000-8000-%012d',value),?,?,?,1 FROM json_each(?)`,
          )
          .bind(
            'f'.repeat(64),
            JSON.stringify({ id: 'synthetic', title: 'Synthetic receipt', description: 'Receipt "text".\n'.repeat(1000) }),
            Date.now(),
            JSON.stringify(Array.from({ length: 100 }, (_, index) => index)),
          )
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
          await meter.measure(
            '100 current change records',
            () => read('/api/tasks/v1/changes?page_size=100'),
            7,
          ),
        ];
        const writer = await harness.mf.getWorker('tasks-read-write');
        const backupPage = async (table: string, range: { after: number; through: number } | null) => {
          if (!range) throw new Error('Missing backup range');
          const response = await writer.fetch('https://tasks.internal/backup', {
            method: 'POST',
            body: JSON.stringify({ table, ...range }),
          });
          const answer = (await response.json()) as { status: number; body: string };
          expect(answer.status, answer.body.slice(0, 200)).toBe(200);
          expect((JSON.parse(answer.body) as { rows: unknown[] }).rows.length).toBeGreaterThan(0);
        };
        const range = (sql: string) => harness.db.prepare(sql).first<{ after: number; through: number }>();
        const longTasks = await range(
          "SELECT min(rowid)-1 AS after, max(rowid) AS through FROM tasks WHERE id LIKE 'synthetic-%'",
        );
        const wideTasks = await range(
          "SELECT min(rowid)-1 AS after, max(rowid) AS through FROM tasks WHERE id LIKE 'backup-cpu-%'",
        );
        const receipts = await range('SELECT 0 AS after, max(rowid) AS through FROM requests');
        measurements.push(
          await meter.measure('backup page of 100 tasks with 15 KB descriptions', () => backupPage('tasks', longTasks), 7),
          await meter.measure('backup page of 100 tasks with 48 KB descriptions', () => backupPage('tasks', wideTasks), 7),
          await meter.measure('backup page of 100 receipts of 16 KB', () => backupPage('requests', receipts), 7),
        );
        const csrf = await harness.fetch('/api/tasks/csrf');
        const { token } = await csrf.json<{ token: string }>();
        let reorderBatch = 0;
        measurements.push(
          await meter.measure(
            'atomically reorder 100 tasks without reading their descriptions',
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
              expect(await response.json()).toEqual({});
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
