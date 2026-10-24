/**
 * Worker "mailsort" (../../docs/design.md): the owner's Gmail sorting. The fetch handler authenticates the owner API or
 * the independent machine runner, then forwards to MailsortState. Its existing SQLite, Alarm and Gmail ledger
 * persist Codex decisions and recover Gmail writes. No cron trigger, no D1, no R2. The named entrypoint Ops answers
 * the dashboard (ops-v1).
 */
import type { Env } from './env.ts';
import { handleRequest } from './http.ts';

export { MailsortState } from './state.ts';
// ops-v1 for the dashboard's service binding (no public route).
export { Ops } from './ops.ts';

export default {
  fetch(request, env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
