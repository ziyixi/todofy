/**
 * Bindings, vars and secrets of the Worker "mailsort" (../../wrangler.toml, ../../docs/design.md §10).
 */
import type { MailsortState } from './state.ts';

/** The name of the single MailsortState instance. */
export const MAILSORT_OBJECT = 'mailsort-v1';
/** The header the Worker passes its request ID to MailsortState in. */
export const REQUEST_ID_HEADER = 'x-mailsort-request-id';

/** What the Worker needs of the Workers AI binding: one method (the tests and local development replace it). */
export interface AiRunner {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface Env {
  /** The single SQLite-backed object "mailsort-v1": every label, rule, decision and example, and the scheduler. */
  readonly MAILSORT: DurableObjectNamespace<MailsortState>;
  /** The UI's static files (web/dist). */
  readonly ASSETS: Fetcher;
  /** Workers AI: the decision models (Clef, Clef-flash) and the embedding model. Absent in tests and local development. */
  readonly AI?: AiRunner;

  // vars (committed in ../../wrangler.toml; BUILD_SHA and MODE added at deploy by deploy/deploy-vars.mjs)
  /** The app's host, sort.ziyixi.science: the CSRF Origin. */
  readonly PUBLIC_HOST?: string;
  readonly ACCESS_ISSUER?: string;
  readonly ACCESS_AUDIENCE?: string;
  readonly BUILD_SHA?: string;
  /**
   * The GitHub variable MAILSORT_MODE: the highest mode the deployment allows (`live`, `shadow` or `off`). The owner's
   * mode in the dashboard is lowered to it; anything else reads as `off` (fail closed).
   */
  readonly MODE?: string;

  // secrets from the deploy (GitHub's production environment)
  readonly ACCESS_OWNER?: string;
  readonly ACCESS_OWNER_ALIASES?: string;
  /** 64 hex characters: HMAC key of the mailsort_csrf tokens. */
  readonly CSRF_SIGNING_KEY?: string;

  // secrets the owner puts with `wrangler secret put` from their own machine (deploy/mint-token.mjs); never in GitHub,
  // never sent or removed by a deploy (--secrets-file keeps the secrets it does not name).
  readonly GMAIL_CLIENT_ID?: string;
  readonly GMAIL_CLIENT_SECRET?: string;
  readonly GMAIL_REFRESH_TOKEN?: string;

  // local development and tests only (.dev.vars, ../../wrangler.test.toml, the workerd harness); never in production
  readonly DEV_AUTH_BYPASS?: string;
  /** `true`: MailsortState never arms its alarm and reads a clock the tests set; the tests call `step(now)`. */
  readonly DEV_MANUAL_ALARMS?: string;
  /**
   * `http://127.0.0.1:<port>`: every Google request and every Workers AI call goes to this local fake (the smoke test's
   * fake Gmail and fake Workers AI) instead. Honoured only together with DEV_AUTH_BYPASS and only for a loopback origin.
   */
  readonly DEV_FAKE_UPSTREAM?: string;
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

export type ModeName = 'off' | 'shadow' | 'live';

/** The deployment's ceiling (MODE): an unknown or missing value is `off`. */
export function modeCeiling(env: Pick<Env, 'MODE'>): ModeName {
  const value = (env.MODE ?? '').trim();
  return value === 'live' || value === 'shadow' ? value : 'off';
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The loopback origin of local development's fakes (DEV_FAKE_UPSTREAM), or null: only with DEV_AUTH_BYPASS and a
 * plain-http loopback origin. Production never sets either variable (.github/scripts/test_wrangler_configs.py refuses
 * DEV_ vars in a production config).
 */
export function devUpstream(env: Pick<Env, 'DEV_FAKE_UPSTREAM' | 'DEV_AUTH_BYPASS'>): string | null {
  if (env.DEV_AUTH_BYPASS !== 'true' || env.DEV_FAKE_UPSTREAM === undefined || env.DEV_FAKE_UPSTREAM === '') return null;
  try {
    const origin = new URL(env.DEV_FAKE_UPSTREAM);
    return origin.protocol === 'http:' && LOOPBACK.has(origin.hostname) ? origin.origin : null;
  } catch {
    return null;
  }
}

/** The header that carries a redirected request's original URL to the local fake. */
export const ORIGINAL_URL_HEADER = 'x-mailsort-original-url';

/**
 * The fetch every Google request goes through: the platform's, or in local development the loopback fake (the path
 * and query kept, the original URL in ORIGINAL_URL_HEADER). gmail.ts checks every request against its closed table
 * before it reaches this function, with the real Google URL.
 */
export function upstreamFetch(env: Pick<Env, 'DEV_FAKE_UPSTREAM' | 'DEV_AUTH_BYPASS'>): typeof fetch {
  const origin = devUpstream(env);
  if (origin === null) return (input, init) => fetch(input, init);
  return (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set(ORIGINAL_URL_HEADER, request.url);
    return fetch(new Request(`${origin}${target.pathname}${target.search}`, { method: request.method, headers, body: request.body, redirect: 'manual' }));
  };
}

/**
 * The Workers AI runner: the binding, or in local development the loopback fake's `POST /ai/run/<model>` with the
 * input as JSON. Null when neither exists (tests that never decide with the model).
 */
export function aiRunner(env: Pick<Env, 'AI' | 'DEV_FAKE_UPSTREAM' | 'DEV_AUTH_BYPASS'>, fetcher: typeof fetch = fetch): AiRunner | null {
  const origin = devUpstream(env);
  if (origin !== null) {
    return {
      async run(model, input) {
        const response = await fetcher(`${origin}/ai/run/${model}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
        const body: unknown = await response.json();
        if (!response.ok) {
          // The fake answers {"error": "<message>"}, as the binding throws an Error with the message.
          const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : 'ai_error';
          throw new Error(message);
        }
        return body;
      },
    };
  }
  return env.AI ?? null;
}
