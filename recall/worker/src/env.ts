/**
 * Bindings, vars and secrets of the Worker "recall" (../../wrangler.toml, ../../docs/design.md §2).
 */
import type { RecallState } from './state.ts';

/** The name of the single RecallState instance. */
export const RECALL_OBJECT = 'recall-v1';
/** The header the Worker passes its request ID to RecallState in. */
export const REQUEST_ID_HEADER = 'x-recall-request-id';

export interface Env {
  /** The single SQLite-backed object "recall-v1": pages, visits, documents' metadata, the index and the feed. */
  readonly RECALL: DurableObjectNamespace<RecallState>;
  /** The private bucket recall-store: each captured text at its archive path, `blobs/<YYYY>/<MM>/<uuid>.txt.gz`. */
  readonly STORE: R2Bucket;
  /** The UI's static files (web/dist). */
  readonly ASSETS: Fetcher;

  // vars (committed in ../../wrangler.toml; BUILD_SHA added at deploy by deploy/deploy-vars.mjs)
  /** The app's host, recall.ziyixi.science: the CSRF Origin, and a host recall never records. */
  readonly PUBLIC_HOST?: string;
  readonly ACCESS_ISSUER?: string;
  readonly ACCESS_AUDIENCE?: string;
  readonly BUILD_SHA?: string;

  // secrets from the deploy (GitHub's production environment)
  readonly ACCESS_OWNER?: string;
  readonly ACCESS_OWNER_ALIASES?: string;
  /** 64 hex characters: HMAC key of the recall_csrf tokens. */
  readonly CSRF_SIGNING_KEY?: string;

  // secrets the owner puts from their own machine (deploy/mint-tokens.mjs, `wrangler secret put`): the SHA-256 (hex) of
  // each machine token, the current one and the one before a rotation. Never in GitHub; a deploy keeps them.
  readonly INGEST_TOKEN_SHA256?: string;
  readonly INGEST_TOKEN_SHA256_PREVIOUS?: string;
  readonly EXPORT_TOKEN_SHA256?: string;
  readonly EXPORT_TOKEN_SHA256_PREVIOUS?: string;

  // local development and tests only (.dev.vars, ../../wrangler.test.toml, the workerd harness); never in production
  readonly DEV_AUTH_BYPASS?: string;
  /** `true`: RecallState never arms its alarm and reads a clock the tests set; the tests call `step(now)`. */
  readonly DEV_MANUAL_ALARMS?: string;
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
