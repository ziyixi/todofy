/**
 * Bindings, vars and secrets of the Worker "lab" (../wrangler.toml, docs/design.md §3).
 */
import type { TaskIntentOps } from '../../../contracts/task-intent-v1/task-intent-v1.ts';
import type { LabState } from './state.ts';

/** Todofy's named entrypoint "Ops" as Lab sees it: only the task-intent-v1 methods (docs/design.md §9). */
export interface TodofyIntentEntrypoint extends Rpc.WorkerEntrypointBranded, TaskIntentOps {}

export interface Env {
  readonly DB: D1Database;
  readonly LAB: DurableObjectNamespace<LabState>;
  readonly AI: Ai;
  readonly ASSETS: Fetcher;
  /** Service binding to the Worker "todofy", entrypoint "Ops" (contracts/task-intent-v1). */
  readonly TODOFY: Service<TodofyIntentEntrypoint>;

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

  // local development and tests only (.dev.vars, the workerd harness); never in the production config
  readonly DEV_AUTH_BYPASS?: string;
  /** `true`: LabState never arms its alarm; the workerd tests drive `step(now)` through the object binding. */
  readonly DEV_MANUAL_ALARMS?: string;
}
