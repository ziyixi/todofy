/**
 * Bindings, vars and secrets of the Worker "lab" (../wrangler.toml, docs/design.md §3).
 */
import type { LabState } from './state.ts';

export interface Env {
  readonly DB: D1Database;
  readonly LAB: DurableObjectNamespace<LabState>;
  readonly AI: Ai;
  readonly ASSETS: Fetcher;

  // vars (committed in ../wrangler.toml; BUILD_SHA added at deploy by deploy/deploy-vars.mjs)
  /** The Lab's own host, e.g. lab.ziyixi.science: CSRF Origin and the ops-v1 ui_url. */
  readonly PUBLIC_HOST: string;
  readonly ACCESS_ISSUER: string;
  readonly ACCESS_AUDIENCE: string;
  /** Hard ceiling of Workers AI neurons per UTC day (decimal integer); the settings page can only lower it. */
  readonly LAB_DAILY_NEURONS: string;
  /** UTC hour (0-23) of the daily feed fetch (at minute 30). */
  readonly LAB_FETCH_UTC_HOUR: string;
  readonly BUILD_SHA?: string;

  // secrets
  readonly ACCESS_OWNER?: string;
  readonly ACCESS_OWNER_ALIASES?: string;
  /** 64 hex characters: HMAC key of the lab_csrf tokens. */
  readonly CSRF_SIGNING_KEY?: string;

  // local development only (.dev.vars); never in the production config
  readonly DEV_AUTH_BYPASS?: string;
}
