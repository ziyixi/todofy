/**
 * Bindings, vars and secrets of the Worker "home" (../wrangler.toml, docs/design.md §2). The apps are
 * reached only through their `Ops` entrypoints (contracts/ops-v1), typed by the generated services of
 * proto/ops/v1 that each one implements; nothing here imports app code.
 */
import type * as ops from '@ziyixi/proto/ops/v1/ops_wire';
import type { HomeState } from './state.ts';

export interface MailHeroOpsEntrypoint extends Rpc.WorkerEntrypointBranded, ops.OpsService, ops.CanaryProducerService {}
export interface TodofyOpsEntrypoint extends Rpc.WorkerEntrypointBranded, ops.OpsService, ops.CanaryConsumerService, ops.OpsDigestService {}
export interface LabOpsEntrypoint extends Rpc.WorkerEntrypointBranded, ops.OpsService {}
export interface WatchOpsEntrypoint extends Rpc.WorkerEntrypointBranded, ops.OpsService {}

export interface Env {
  readonly MAIL_HERO: Service<MailHeroOpsEntrypoint>;
  readonly TODOFY: Service<TodofyOpsEntrypoint>;
  readonly LAB: Service<LabOpsEntrypoint>;
  readonly WATCH: Service<WatchOpsEntrypoint>;
  readonly FLEET: Service<WatchOpsEntrypoint>;
  readonly NEWSLETTER: Service<WatchOpsEntrypoint>;
  readonly HOME: DurableObjectNamespace<HomeState>;
  readonly ASSETS: Fetcher;

  // vars (committed in ../wrangler.toml; BUILD_SHA and CANARY_ENABLED added at deploy by deploy/deploy-vars.mjs)
  /** The dashboard's own host, e.g. home.ziyixi.science: CSRF Origin and the digest's dashboard_url. */
  readonly PUBLIC_HOST: string;
  readonly ACCESS_ISSUER: string;
  readonly ACCESS_AUDIENCE: string;
  /** Cloudflare account tag for the GraphQL Analytics query. */
  readonly ACCOUNT_ID: string;
  /** UTC hour (0-23) of the daily canary; default 16. */
  readonly CANARY_UTC_HOUR?: string;
  /**
   * `true` (default when unset) or `false`: whether canary runs may start (scheduled and manual). A run
   * already in progress is still polled to its end. Any other value counts as `false`.
   */
  readonly CANARY_ENABLED?: string;
  readonly BUILD_SHA?: string;

  // secrets
  readonly ACCESS_OWNER?: string;
  readonly ACCESS_OWNER_ALIASES?: string;
  /** 64 hex characters: HMAC key of the home_csrf tokens. */
  readonly CSRF_SIGNING_KEY?: string;
  /**
   * Used only for POST https://api.cloudflare.com/client/v4/graphql (usage.ts) and the drift check's
   * read-only GETs under the same API (drift.ts); never logged or sent elsewhere.
   */
  readonly CF_ANALYTICS_TOKEN?: string;

  // local development and the workerd tests only (.dev.vars, test/runtime); never in the production config
  readonly DEV_AUTH_BYPASS?: string;
  /**
   * An RFC 3339 UTC instant (`2026-10-01T12:00:00Z`) that a request signed in by the loopback dev bypass
   * takes as now (config.ts devNow). Requests Access verified, and cron ticks, never read it.
   */
  readonly DEV_NOW?: string;
}
