/**
 * Worker "flowday" (../../docs/design.md): FlowDay's static UI and its small owner API on D1, on Workers Free
 * (10 ms CPU per request, no cron, no Durable Object). The module exports only the handler (workerd treats every
 * named export as an entrypoint); the router lives in ./router.ts.
 */
import type { Env } from './env.ts';
import { handleRequest } from './router.ts';

export default {
  fetch(request, env): Promise<Response> {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
