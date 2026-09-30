/**
 * Worker "lab" (docs/design.md). The fetch handler only authenticates, validates, reads D1 for the deck
 * pages and calls LabState over RPC (Workers Free: 10 ms CPU per request); LabState does the pipeline in its
 * alarm (30 s CPU per invocation). No cron trigger: LabState schedules itself with setAlarm(), bootstrapped
 * by the first GET /api/today or the first ops-v1 status() from the dashboard, whichever comes first.
 */
import type { Env } from './env.ts';
import { handleRequest } from './http.ts';

export { LabState } from './state.ts';
export { Ops } from './ops.ts';

export default {
  fetch(request, env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
