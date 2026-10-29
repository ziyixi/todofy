/**
 * The startup warm-up of src/startup.ts. It runs listTasks and getGoalCatalog over stub D1s and only logs a failure (a
 * Worker must start without it), so this test is what notices a change to their queries that the stubs do not answer.
 */
import { expect, test, vi } from 'vitest';
import { warmUp } from '../src/startup.ts';

test('the warm-up runs the task page and the goal catalog whole, without a failure it would only log', async () => {
  const logged = vi.spyOn(console, 'error');
  try {
    await warmUp('America/Los_Angeles');
    expect(logged).not.toHaveBeenCalled();
  } finally {
    logged.mockRestore();
  }
});
