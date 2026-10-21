/**
 * The entrypoints the release of 2026-10-21 retired, kept as refusals for that release only. Todofy deploys before
 * the Workers that bound them (Tasks' PLANNING, the Personal MCP's TODOFY_MAIL, Watch's TODOFY), so for the minutes
 * until their own deploys their old versions get a refusal and nothing is written. Delete them with the next Todofy
 * release, once no live Worker binds them (proto/retired.json lists the IDL they served).
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './env.ts';

/** PlusService for Tasks' Mail page and Plan's weekly review: Tasks binds Mail now. */
export class Planning extends WorkerEntrypoint<Env> {
  override fetch(): Response {
    return new Response(null, { status: 404 });
  }
}

/** PlusService and MailReadinessService for the Personal MCP: it binds Mail now. */
export class MailApi extends WorkerEntrypoint<Env> {
  override fetch(): Response {
    return new Response(null, { status: 404 });
  }
}

/**
 * task-intent-v1 for Watch: it creates its tasks through Tasks' TaskInbox now. `unavailable` is the one answer that
 * keeps the old sink's proposals open, so its successor sends them to Tasks.
 */
export class Intents extends WorkerEntrypoint<Env> {
  proposeTasks(): Promise<never> {
    return Promise.reject(new Error('unavailable'));
  }

  taskIntentStatus(): Promise<never> {
    return Promise.reject(new Error('unavailable'));
  }
}
