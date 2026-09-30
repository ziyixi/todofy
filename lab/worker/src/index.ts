/**
 * Worker "lab" (docs/design.md). The fetch handler only authenticates, routes and calls LabState over RPC
 * (Workers Free: 10 ms CPU per request); LabState does the work in its alarm (30 s CPU per invocation).
 * No cron trigger: LabState schedules itself with setAlarm().
 */
import type { Env } from './env.ts';

export { LabState } from './state.ts';
export { Ops } from './ops.ts';

export default {
  // Scaffold: the owner API, Access/CSRF (packages/edge-auth) and the assets hand-off land in http.ts.
  fetch(): Promise<Response> {
    return Promise.resolve(Response.json({ error: { code: 'not_implemented', message: '尚未实现' } }, { status: 503 }));
  },
} satisfies ExportedHandler<Env>;
