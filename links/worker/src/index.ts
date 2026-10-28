/**
 * Worker "links" (../../docs/design.md): the owner's short links on s.ziyixi.science and the owner API and launcher
 * under /_/. A redirect is one D1 read by primary key; everything else is the owner's (Workers Free: 10 ms of CPU per
 * request). The one cron trigger runs the daily backup a bounded step at a time (backup-runner.ts); the named
 * entrypoint Ops answers Home through its service binding (ops-v1). No Durable Object, no queue.
 */
import { runBackup } from './backup-runner.ts';
import type { Env } from './env.ts';
import { handleRequest } from './http.ts';

export default {
  fetch(request, env): Promise<Response> {
    return handleRequest(request, env);
  },
  async scheduled(controller, env): Promise<void> {
    try {
      await runBackup(env, controller.scheduledTime);
    } catch (error) {
      // R2 did not answer for state.json: the next tick tries again. A code only, never content.
      console.log(JSON.stringify({ backup: { tick_error: error instanceof Error ? error.name : 'unknown' } }));
    }
  },
} satisfies ExportedHandler<Env>;

export { Ops } from './ops.ts';
