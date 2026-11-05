import { expect, test } from 'vitest';
import { BUILD_HEADER, UNKNOWN_ROUTE } from '../../../shared/build.ts';
import { startHarness } from './harness.ts';

const build = 'c'.repeat(40);

test('every owner answer names the Worker build, an unknown route says so, and nothing anonymous shows it', async () => {
  const owner = await startHarness({ build });
  const anonymous = await startHarness({ build, bypass: false });
  try {
    // Tasks' own API, the CSRF token, Todofy's proxied Mail API (here unconnected) and the page.
    for (const path of ['/api/tasks/v1/catalog', '/api/tasks/csrf', '/api/plus/v1/mailItems', '/'])
      expect((await owner.fetch(path)).headers.get(BUILD_HEADER), path).toBe(build);
    const unknown = await owner.fetch('/api/tasks/v1/retiredMethod');
    const body = (await unknown.json()) as { error: { message: string } };
    expect([unknown.status, unknown.headers.get(BUILD_HEADER), body.error.message]).toEqual([404, build, UNKNOWN_ROUTE]);
    const refused = await anonymous.fetch('/api/tasks/v1/catalog');
    expect([refused.status, refused.headers.get(BUILD_HEADER)]).toEqual([401, null]);
  } finally {
    await owner.dispose();
    await anonymous.dispose();
  }
});

test('Home sees database readiness without activity warnings or a public machine route', async () => {
  const harness = await startHarness();
  try {
    const client = await harness.mf.getWorker('tasks-ops');
    const response = await client.fetch('https://tasks-ops.internal/');
    const status = (await response.json()) as {
      app: string;
      health: string;
      capabilities: string[];
      signals: unknown[];
      counters: Record<string, number>;
    };
    expect(status.app).toBe('tasks');
    expect(status.health).toBe('ok');
    expect(status.signals).toEqual([]);
    expect(status.capabilities).toEqual([]);
    expect(status.counters.database_ready).toBe(1);
    expect((await client.fetch('https://tasks-ops.internal/guard')).status).toBe(400);
    expect((await harness.fetch('/api/tasks/ops')).status).toBe(404);
    await harness.db.prepare('DROP TABLE changes').run();
    const failed = (await (await client.fetch('https://tasks-ops.internal/')).json()) as {
      health: string;
      signals: { code: string }[];
    };
    expect(failed.health).toBe('down');
    expect(failed.signals[0]?.code).toBe('status_unavailable');
  } finally {
    await harness.dispose();
  }
});
