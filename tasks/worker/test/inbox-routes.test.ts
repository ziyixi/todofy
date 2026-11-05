import { expect, test } from 'vitest';
import { routedProject } from '../src/inbox-routes.ts';

function fakeRouteDb(result: { project_id: string | null } | null, shouldThrow = false): D1Database {
  return {
    prepare: () => ({
      bind: (...args: unknown[]) => ({
        args,
        first: () => (shouldThrow ? Promise.reject(new Error('d1 down')) : Promise.resolve(result)),
      }),
    }),
  } as unknown as D1Database;
}

test('routedProject returns the live routed project ID or falls back to Inbox when missing or archived', async () => {
  await expect(routedProject(fakeRouteDb({ project_id: 'proj-watch' }), 'watch')).resolves.toBe('proj-watch');
  await expect(routedProject(fakeRouteDb(null), 'home')).resolves.toBe('');
  await expect(routedProject(fakeRouteDb({ project_id: null }), 'review')).resolves.toBe('');
  await expect(routedProject(fakeRouteDb(null, true), 'home')).rejects.toThrow(
    'Task storage is temporarily unavailable',
  );
});
