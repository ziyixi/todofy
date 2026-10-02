/**
 * Bindings, vars and secrets of the Worker "watch" (../../wrangler.toml, ../../docs/design.md §7).
 */
import type { FetchFn } from './fetcher.ts';
import type { WatchState } from './state.ts';
import type { TodofyIntentEntrypoint } from './todofy.ts';

/** The name of the single WatchState instance. */
export const WATCH_OBJECT = 'watch-v1';
/** The header the Worker passes its request ID to WatchState in. */
export const REQUEST_ID_HEADER = 'x-watch-request-id';

export interface Env {
  /** The single SQLite-backed object "watch-v1": every watch, snapshot and change, and the scheduler. */
  readonly WATCH: DurableObjectNamespace<WatchState>;
  /** The UI's static files (web/dist). */
  readonly ASSETS: Fetcher;
  /**
   * The browser renderer for FETCHER_BROWSER watches (browser.ts). Absent in v1: the production config has no
   * browser binding, so such watches are refused (BROWSER_NOT_AVAILABLE). The workerd tests bind a fake one.
   */
  readonly BROWSER?: Fetcher;
  /**
   * Service binding to the Worker "todofy", entrypoint "Ops" (contracts/task-intent-v1): the notification sink
   * (todofy.ts). Absent in local development and in most workerd tests: the outbox then only fills.
   */
  readonly TODOFY?: Service<TodofyIntentEntrypoint>;

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
  readonly CSRF_SIGNING_KEY?: string;

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
