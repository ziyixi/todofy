/**
 * Worker "watch" (../../docs/design.md): the owner's web watches. The fetch handler authenticates the owner and hands
 * the owner API to WatchState, the one SQLite Durable Object that holds everything and schedules every check with
 * setAlarm. No cron trigger, no D1, no R2.
 */
import type { Env } from './env.ts';
import { handleRequest } from './http.ts';

export { WatchState } from './state.ts';

export default {
  fetch(request, env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
