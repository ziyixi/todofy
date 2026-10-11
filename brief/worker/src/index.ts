/**
 * Worker "brief" (../../docs/design.md): the owner's daily research-and-world briefing. The fetch handler checks every
 * caller (the feedback route's signed token, the owner's Access login on everything else) and makes one call to
 * BriefState, the one SQLite Durable Object that fetches the sources, calls Claude, checks, renders and sends, and
 * schedules itself with setAlarm. No cron trigger, no D1, no R2, no KV, no queue. The named entrypoint Ops answers the
 * dashboard (ops-v1).
 */
import type { Env } from './env.ts';
import { handleRequest } from './http.ts';

export { BriefState } from './state.ts';
// ops-v1 for the dashboard's service binding (no public route).
export { Ops } from './ops.ts';

export default {
  fetch(request, env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
