/**
 * Bindings, vars and secrets of the Worker "flowday" (../../wrangler.toml, ../../docs/design.md "Configuration").
 */
export interface Env {
  readonly DB: D1Database;
  readonly ASSETS: Fetcher;

  // vars (committed in ../../wrangler.toml; BUILD_SHA added at deploy by deploy/deploy-vars.mjs)
  /** FlowDay's own host once it has one (F3/F4): the CSRF Origin. Absent: only the dev bypass can mutate. */
  readonly PUBLIC_HOST?: string;
  readonly ACCESS_ISSUER: string;
  readonly ACCESS_AUDIENCE: string;
  readonly BUILD_SHA?: string;

  // secrets
  readonly ACCESS_OWNER?: string;
  readonly ACCESS_OWNER_ALIASES?: string;
  /** 64 hex characters: HMAC key of the flowday_csrf tokens. */
  readonly CSRF_SIGNING_KEY?: string;
  /** 64 hex characters: AES-256-GCM key that seals the Todoist API key in D1 (./credentials.ts). */
  readonly CREDENTIAL_KEY?: string;

  // local development and tests only (.dev.vars, `wrangler dev --var`, the workerd harness); never committed
  readonly DEV_AUTH_BYPASS?: string;
  /** `true` together with an active loopback dev bypass: the /api/test/* routes the Playwright suite drives. */
  readonly E2E_TEST_ROUTES?: string;
  /** Overrides the Todoist API origin (tests only, loopback dev bypass only). */
  readonly DEV_TODOIST_ORIGIN?: string;
}
