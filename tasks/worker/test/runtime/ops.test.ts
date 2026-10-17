import { test, expect } from 'vitest';
import { startHarness } from './harness.ts';

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
