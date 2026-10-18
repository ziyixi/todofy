import { test, expect } from 'vitest';
import {
  COLD_ISOLATES,
  connectCpuMeter,
  CPU_TEST_TIMEOUT_MS,
  measureInIsolates,
} from '../../../../tools/workerd-cpu/workerd-cpu.mts';
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
