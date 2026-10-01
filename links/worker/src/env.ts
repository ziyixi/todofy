/**
 * Bindings, vars and secrets of the Worker "links" (../../wrangler.toml, ../../docs/design.md §7).
 */
export interface Env {
  readonly DB: D1Database;
  /** The launcher's static files (web/dist); the Worker serves its index for /_/ and /_/k/... itself. */
  readonly ASSETS: Fetcher;

  // vars (committed in ../../wrangler.toml; BUILD_SHA added at deploy by deploy/deploy-vars.mjs)
  /** The links host, e.g. s.ziyixi.science: the CSRF Origin, and the one host no target may name. */
  readonly PUBLIC_HOST?: string;
  readonly ACCESS_ISSUER?: string;
  readonly ACCESS_AUDIENCE?: string;
  readonly BUILD_SHA?: string;

  // secrets
  readonly ACCESS_OWNER?: string;
  readonly ACCESS_OWNER_ALIASES?: string;
  /** 64 hex characters: HMAC key of the links_csrf tokens. */
  readonly CSRF_SIGNING_KEY?: string;

  // local development and tests only (.dev.vars, the workerd harness); never in the production config
  readonly DEV_AUTH_BYPASS?: string;
}

/** The lower-case public host, or null when it is not a plain host name. */
export function publicHost(env: Pick<Env, 'PUBLIC_HOST'>): string | null {
  const host = (env.PUBLIC_HOST ?? '').trim().toLowerCase();
  return /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ? host : null;
}
