/**
 * Worker "links" (../../docs/design.md): the owner's short links on s.ziyixi.science and the owner API and launcher
 * under /_/. The fetch handler is all there is: no cron, no Durable Object, no queue. A redirect is one D1 read by
 * primary key; everything else is the owner's (Workers Free: 10 ms of CPU per request).
 */
import type { Env } from './env.ts';
import { handleRequest } from './http.ts';

export default {
  fetch(request, env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
