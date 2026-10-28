/**
 * Bindings, vars and secrets of the Worker "watch" (../../wrangler.toml, ../../docs/design.md §7).
 */
import type { FetchFn } from './fetcher.ts';
import type { WatchState } from './state.ts';
import type { TaskInboxEntrypoint } from './tasks.ts';

/** The name of the single WatchState instance. */
export const WATCH_OBJECT = 'watch-v1';
/** The header the Worker passes its request ID to WatchState in. */
export const REQUEST_ID_HEADER = 'x-watch-request-id';
/** Set only by WatchApi; public forwarding always removes it. */
export const PRIVATE_API_HEADER = 'x-watch-private-api';

export interface Env {
  /** The single SQLite-backed object "watch-v1": every watch, snapshot and change, and the scheduler. */
  readonly WATCH: DurableObjectNamespace<WatchState>;
  /** The UI's static files (web/dist). */
  readonly ASSETS: Fetcher;
  /** Private saved text and screenshots; managed by the Watch snapshot index. */
  readonly EVIDENCE_STORE?: R2Bucket;
  /**
   * Private daily backups (backup.ts, ../../docs/backup.md): the store's tables and a copy of every evidence object
   * they name; RestoreBackup (restore.ts) reads them back into an empty store. Absent in local development and most
   * workerd tests: then nothing is backed up.
   */
  readonly BACKUPS?: R2Bucket;
  /**
   * Browser Run for rendered page evidence (browser.ts). Production uses the official Puppeteer transport;
   * local manual tests inject their synthetic renderer.
   */
  readonly BROWSER?: Fetcher;
  /**
   * Service binding to the Worker "tasks", entrypoint "TaskInbox" with `props.source = "watch"` (proto/tasks/inbox/v1:
   * it creates tasks only, no read, update or delete): the notification sink (tasks.ts). Absent in local development and
   * in most workerd tests: the outbox then only fills.
   */
  readonly TASKS?: Service<TaskInboxEntrypoint>;

  // vars (committed in ../../wrangler.toml; BUILD_SHA added at deploy by deploy/deploy-vars.mjs)
  /** The watch host, e.g. watch.ziyixi.science: the CSRF Origin. */
  readonly PUBLIC_HOST?: string;
  readonly ACCESS_ISSUER?: string;
  readonly ACCESS_AUDIENCE?: string;
  readonly BUILD_SHA?: string;

  // secrets
  readonly ACCESS_OWNER?: string;
  readonly ACCESS_OWNER_ALIASES?: string;
  /** 64 hex characters: HMAC key of the watch_csrf tokens. */

  // local development and tests only (.dev.vars, the workerd harness); never in the production config
  readonly DEV_AUTH_BYPASS?: string;
  /** `true`: WatchState never arms its alarm and reads a clock the tests set; the tests call `step(now)`. */
  readonly DEV_MANUAL_ALARMS?: string;
  /**
   * `http://127.0.0.1:<port>` (or localhost): every outbound page request goes to this local fake site instead,
   * with the original URL in the `x-watch-original-url` header (`wrangler dev` with synthetic sites). Honoured only
   * together with DEV_AUTH_BYPASS and only for a loopback origin.
   */
  readonly DEV_FAKE_UPSTREAM?: string;
  /** Milliseconds: the fetch timeout instead of FETCH_TIMEOUT_MS (DEV_MANUAL_ALARMS only: the timeout tests). */
  readonly DEV_FETCH_TIMEOUT_MS?: string;
}

/** The lower-case public host, or null when it is not a plain host name. */
export function publicHost(env: Pick<Env, 'PUBLIC_HOST'>): string | null {
  const host = (env.PUBLIC_HOST ?? '').trim().toLowerCase();
  return /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ? host : null;
}

/** The deployed commit (BUILD_SHA), or `dev`. */
export function buildSha(env: Pick<Env, 'BUILD_SHA'>): string {
  const sha = (env.BUILD_SHA ?? '').trim();
  return /^[0-9a-f]{7,40}$|^dev$|^test$/.test(sha) ? sha : 'dev';
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The fetch of local development against synthetic sites (DEV_FAKE_UPSTREAM), or null: only with DEV_AUTH_BYPASS and
 * a plain-http loopback origin. Every request keeps its path and query and goes to that origin, with its original URL in
 * `x-watch-original-url` (the fake server routes by it). Production never sets either variable
 * (.github/scripts/test_wrangler_configs.py refuses DEV_ vars in a committed config).
 */
export function devFetch(env: Pick<Env, 'DEV_FAKE_UPSTREAM' | 'DEV_AUTH_BYPASS'>): FetchFn | null {
  if (env.DEV_AUTH_BYPASS !== 'true' || env.DEV_FAKE_UPSTREAM === undefined || env.DEV_FAKE_UPSTREAM === '') return null;
  let origin: URL;
  try {
    origin = new URL(env.DEV_FAKE_UPSTREAM);
  } catch {
    return null;
  }
  if (origin.protocol !== 'http:' || !LOOPBACK.has(origin.hostname)) return null;
  return (request) => {
    const target = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set('x-watch-original-url', request.url);
    return fetch(new Request(`${origin.origin}${target.pathname}${target.search}`, { method: request.method, headers, redirect: 'manual', signal: request.signal }));
  };
}
