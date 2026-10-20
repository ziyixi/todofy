/**
 * The startup warm-up of src/startup.ts. It runs listTasks over a stub D1 and only logs a failure (a Worker must start
 * without it), so this test is what notices a change to listTasks' queries that the stub does not answer.
 */
import { expect, test, vi } from 'vitest';
import { warmUp } from '../src/startup.ts';

test('the warm-up runs the task page whole, without a failure it would only log', async () => {
  const logged = vi.spyOn(console, 'error');
  try {
    await warmUp('America/Los_Angeles');
    expect(logged).not.toHaveBeenCalled();
  } finally {
    logged.mockRestore();
  }
});
