import type { TaskJobs } from './jobs.ts';

export interface Env {
  DB: D1Database;
  /** The scheduled jobs' object (jobs.ts): the GTD day and the weekly review. */
  JOBS: DurableObjectNamespace<TaskJobs>;
  ASSETS: Fetcher;
  /** Todofy's Mail entry (todofy.mail.v1), read-write. */
  MAIL?: Fetcher;
  PUBLIC_HOST: string;
  TIME_ZONE?: string;
  ACCESS_ISSUER?: string;
  ACCESS_AUDIENCE?: string;
  ACCESS_OWNER?: string;
  ACCESS_OWNER_ALIASES?: string;
  CSRF_SIGNING_KEY?: string;
  DEV_AUTH_BYPASS?: string;
  BUILD_SHA?: string;
}
export function accountZone(env: Env): string {
  return env.TIME_ZONE || 'UTC';
}
