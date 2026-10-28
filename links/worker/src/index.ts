/**
 * Worker "links" (../../docs/design.md): the owner's short links on s.ziyixi.science and the owner API and launcher
 * under /_/. A redirect is one D1 read by primary key; everything else is the owner's (Workers Free: 10 ms of CPU per
 * request). The LinksBackup object's Alarm runs the daily backup a bounded step at a time (backup-alarm.ts); there is
 * no cron trigger. The named entrypoint Ops answers Home through its service binding (ops-v1). No queue.
 */
import { armBackup } from './backup-alarm.ts';
import type { Env } from './env.ts';
import { handleRequest } from './http.ts';

/** Whether this isolate armed the backup's Alarm: once is enough, since every Alarm sets the next. */
let armed = false;

export default {
  fetch(request, env, ctx): Promise<Response> {
    // The owner's half (Access in front of it) arms the backup's Alarm, so the first backup needs no other app. A
    // short link never does: a redirect stays one D1 read and nothing else.
    if (!armed && new URL(request.url).pathname.startsWith('/_/')) {
      armed = true;
      ctx.waitUntil(
        armBackup(env).catch(() => {
          armed = false;
        }),
      );
    }
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;

export { LinksBackup } from './backup-alarm.ts';
export { Ops } from './ops.ts';
