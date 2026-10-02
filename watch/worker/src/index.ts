/**
 * Worker "watch" (../../docs/design.md): the owner's web watches. The fetch handler authenticates the owner and hands
 * the owner API to WatchState, the one SQLite Durable Object that holds everything and schedules every check with
 * setAlarm. No cron trigger, no D1, no R2. The named entrypoint Ops answers the dashboard (ops-v1).
 */
import type { Env } from './env.ts';
import { handleRequest } from './http.ts';

export { WatchState } from './state.ts';
// ops-v1 for the dashboard's service binding (no public route).
export { Ops } from './ops.ts';

export default {
  fetch(request, env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
