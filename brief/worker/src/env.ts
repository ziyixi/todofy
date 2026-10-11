/**
 * Bindings, vars and secrets of the Worker "brief" (../../wrangler.toml, ../../docs/design.md §1).
 */
import type { BriefState } from './state.ts';

/** The name of the single BriefState instance. */
export const BRIEF_OBJECT = 'brief-v1';
/** The header the Worker passes its request ID to BriefState in. */
export const REQUEST_ID_HEADER = 'x-brief-request-id';

/** What the brief needs of the Workers AI binding: one method (the tests replace it with a fake entrypoint). */
export interface AiRunner {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface Env {
  /** The single SQLite-backed object "brief-v1": sources, items, issues, the ledger, costs and the scheduler. */
  readonly BRIEF: DurableObjectNamespace<BriefState>;
  /** The archive UI's static files (web/dist). */
  readonly ASSETS: Fetcher;
  /** Workers AI, for bge-m3 embeddings only. */
  readonly AI?: AiRunner;

  // vars (committed in ../../wrangler.toml; BUILD_SHA and MODE added at deploy by deploy/deploy-vars.mjs)
  /** The app's host, brief.ziyixi.science: the CSRF Origin, the feedback links' host, and a host never fetched. */
  readonly PUBLIC_HOST?: string;
  readonly ACCESS_ISSUER?: string;
  readonly ACCESS_AUDIENCE?: string;
  readonly BUILD_SHA?: string;
  /** The GitHub variable BRIEF_MODE: `off`, `archive`, `shadow` or `live`; anything else reads as `off`. */
  readonly MODE?: string;

  // secrets from the deploy (GitHub's production environment)
  readonly ACCESS_OWNER?: string;
  readonly ACCESS_OWNER_ALIASES?: string;
  /** 64 hex characters: HMAC key of the brief_csrf tokens. */
  readonly CSRF_SIGNING_KEY?: string;
  /** 64 hex characters: HMAC key of the email's feedback links (its own: a machine route never inherits owner rights). */
  readonly FEEDBACK_SIGNING_KEY?: string;
  /** The sender and the recipient (personal values). */
  readonly MAIL_FROM?: string;
  readonly MAIL_TO?: string;

  // secrets the owner puts with `wrangler secret put` from their own machine; never in GitHub, kept by every deploy
  readonly ANTHROPIC_API_KEY?: string;
  readonly RESEND_API_KEY?: string;

  // local development and tests only (.dev.vars, ../../wrangler.test.toml, the workerd harness); never in production
  readonly DEV_AUTH_BYPASS?: string;
  /** `true`: BriefState never arms its alarm and reads a clock the tests set; the tests call `step(now)`. */
  readonly DEV_MANUAL_ALARMS?: string;
  /**
   * `http://127.0.0.1:<port>`: every external request (feeds, pages, Claude, Resend, Workers AI) goes to this local fake
   * instead, with the original URL in ORIGINAL_URL_HEADER. Honoured only with DEV_AUTH_BYPASS and a loopback origin.
   */
  readonly DEV_FAKE_UPSTREAM?: string;
}

export type ModeName = 'off' | 'archive' | 'shadow' | 'live';

/** The deployment's mode (MODE): an unknown or missing value is `off` (fail closed). */
export function mode(env: Pick<Env, 'MODE'>): ModeName {
  const value = (env.MODE ?? '').trim();
  return value === 'archive' || value === 'shadow' || value === 'live' ? value : 'off';
}

/** The lower-case public host, or null when it is not a plain host name. */
export function publicHost(env: Pick<Env, 'PUBLIC_HOST'>): string | null {
  const host = (env.PUBLIC_HOST ?? '').trim().toLowerCase();
  return /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ? host : null;
}

/** The deployed commit (BUILD_SHA), or `dev`. */
export function buildSha(env: Pick<Env, 'BUILD_SHA'>): string {
  const sha = (env.BUILD_SHA ?? '').trim();
  return /^[0-9a-f]{7,40}$|^dev$|^test(-[a-z0-9]{1,16})?$/.test(sha) ? sha : 'dev';
}

/** The Claude API key, or null when none is set. */
export function anthropicKey(env: Pick<Env, 'ANTHROPIC_API_KEY'>): string | null {
  const key = (env.ANTHROPIC_API_KEY ?? '').trim();
  return key === '' ? null : key;
}

const ADDRESS = /^(?=[\x21-\x7e ]+$)[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const NAMED_ADDRESS = /^[^<>\r\n]{0,80}<[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>$/;

/** The mail settings: the Resend key and both addresses (`a@b.c`, or `Name <a@b.c>` for the sender), or null. */
export function mailSettings(env: Pick<Env, 'RESEND_API_KEY' | 'MAIL_FROM' | 'MAIL_TO'>): { key: string; from: string; to: string } | null {
  const key = (env.RESEND_API_KEY ?? '').trim();
  const from = (env.MAIL_FROM ?? '').trim();
  const to = (env.MAIL_TO ?? '').trim();
  if (key === '' || !(ADDRESS.test(from) || NAMED_ADDRESS.test(from)) || !ADDRESS.test(to)) return null;
  return { key, from, to };
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
export const ORIGINAL_URL_HEADER = 'x-brief-original-url';

/**
 * The fetch every external request goes through: the platform's, or in local development the loopback fake (the path
 * and query kept, the original URL in ORIGINAL_URL_HEADER). The URL policy (fetch/policy.ts) checks every request
 * before it reaches this function, with the real URL.
 */
export function upstreamFetch(env: Pick<Env, 'DEV_FAKE_UPSTREAM' | 'DEV_AUTH_BYPASS'>): typeof fetch {
  const origin = devUpstream(env);
  if (origin === null) return (input, init) => fetch(input, init);
  return (input, init) => {
    const request = new Request(input, init);
    const target = new URL(request.url);
    const headers = new Headers(request.headers);
    headers.set(ORIGINAL_URL_HEADER, request.url);
    return fetch(new Request(`${origin}${target.pathname}${target.search}`, { method: request.method, headers, body: request.body, redirect: 'manual', signal: request.signal }));
  };
}

/** The Workers AI runner: the binding, or in local development the loopback fake's `POST /ai/run/<model>`; else null. */
export function aiRunner(env: Pick<Env, 'AI' | 'DEV_FAKE_UPSTREAM' | 'DEV_AUTH_BYPASS'>, fetcher: typeof fetch = fetch): AiRunner | null {
  const origin = devUpstream(env);
  if (origin !== null) {
    return {
      async run(model, input) {
        const response = await fetcher(`${origin}/ai/run/${model}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
        const body: unknown = await response.json();
        if (!response.ok) {
          const message = typeof body === 'object' && body !== null && typeof (body as { error?: unknown }).error === 'string' ? (body as { error: string }).error : 'ai_error';
          throw new Error(message);
        }
        return body;
      },
    };
  }
  return env.AI ?? null;
}
