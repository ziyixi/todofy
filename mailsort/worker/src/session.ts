/**
 * One invocation's access to Google (../../docs/design.md §2.3): the owner's credentials from the Worker secrets, the
 * auth state kept in SQLite, the subrequest budget, and the daily count of calls.
 *
 * Auth failures stop the calls. Google refusing the grant (invalid_grant, a 401) AUTH_FAILURES_STOP times in a row
 * marks the grant `failed`: no further request goes to Google until the refresh token changes (its fingerprint, a
 * hash, differs from the failed one), so a revoked grant cannot be hammered every five minutes. The failure reaches Home
 * as the ops-v1 signal `gmail_auth_failed` (and so the daily digest).
 */
import type { Env } from './env.ts';
import { GmailClient, GoogleError, type AccessToken, type Ownership } from './gmail.ts';
import { AUTH_FAILURES_STOP } from './limits.ts';
import { utcDay, type Store } from './store.ts';

/** Subrequests left in this invocation (Google and Workers AI together). */
export class Budget {
  left: number;

  constructor(left: number) {
    this.left = left;
  }

  /** Takes `n` if they are left. */
  take(n = 1): boolean {
    if (this.left < n) return false;
    this.left -= n;
    return true;
  }

  has(n: number): boolean {
    return this.left >= n;
  }
}

export type AuthState = 'not_configured' | 'ok' | 'failed' | 'unknown';

async function fingerprint(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`mailsort-grant:${token}`)));
  return Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The auth state as stored (`unknown` before the first refresh of this grant). */
export function authState(store: Store, env: Pick<Env, 'GMAIL_CLIENT_ID' | 'GMAIL_CLIENT_SECRET' | 'GMAIL_REFRESH_TOKEN'>): AuthState {
  if (!configured(env)) return 'not_configured';
  const state = store.getMeta('auth_state');
  return state === 'ok' || state === 'failed' ? state : 'unknown';
}

export function configured(env: Pick<Env, 'GMAIL_CLIENT_ID' | 'GMAIL_CLIENT_SECRET' | 'GMAIL_REFRESH_TOKEN'>): boolean {
  return [env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET, env.GMAIL_REFRESH_TOKEN].every((value) => typeof value === 'string' && value.trim() !== '');
}

export interface SessionOptions {
  readonly store: Store;
  readonly env: Pick<Env, 'GMAIL_CLIENT_ID' | 'GMAIL_CLIENT_SECRET' | 'GMAIL_REFRESH_TOKEN'>;
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly budget: Budget;
  /** The access token cached by the object between invocations. */
  readonly token: AccessToken | null;
}

/**
 * A GmailClient for this invocation, or the reason there is none: `not_configured` (no secrets), `stopped` (the grant
 * failed and has not changed).
 */
export async function openSession(options: SessionOptions): Promise<{ client: GmailClient } | { reason: 'not_configured' | 'stopped' }> {
  const { store, env } = options;
  if (!configured(env)) return { reason: 'not_configured' };
  const print = await fingerprint(env.GMAIL_REFRESH_TOKEN ?? '');
  if (store.getMeta('auth_fingerprint') !== print) {
    // A new grant (the owner ran mint-token again): forget the old one's failures.
    store.setMeta('auth_fingerprint', print);
    store.setMeta('auth_failures', '0');
    store.setMeta('auth_state', 'unknown');
  }
  if (store.getMeta('auth_state') === 'failed') return { reason: 'stopped' };
  const ownership: Ownership = {
    ownedLabelIds: () => store.ownedGmailIds(),
    ledger: (messageId, labelId) => {
      const row = store.ledgerFor(messageId, labelId);
      return row === undefined ? null : { state: row.state, archived: row.archived === 1 };
    },
  };
  const client = new GmailClient({
    fetch: options.fetch,
    credentials: { clientId: env.GMAIL_CLIENT_ID ?? '', clientSecret: env.GMAIL_CLIENT_SECRET ?? '', refreshToken: env.GMAIL_REFRESH_TOKEN ?? '' },
    ownership,
    now: options.now,
    token: options.token,
    onCall: () => {
      options.budget.left -= 1;
      store.addUsage(utcDay(options.now()), 'gmail_calls', 1);
    },
  });
  return { client };
}

/** After a successful token refresh: the grant works, and whether it allows writes. */
export function noteTokenOk(store: Store, token: AccessToken): void {
  store.setMeta('auth_state', 'ok');
  store.setMeta('auth_failures', '0');
  store.setMeta('write_scope', token.writeScope ? '1' : '0');
}

/**
 * Records a Google failure: its code for the status page, and for an auth refusal one more strike towards `failed`.
 * Answers true when the invocation should stop calling Google (auth, rate, unavailable).
 */
export function noteGoogleError(store: Store, error: unknown): boolean {
  if (!(error instanceof GoogleError)) {
    store.pushError('gmail_unexpected');
    return true;
  }
  store.pushError(error.code);
  if (error.kind === 'auth') {
    const failures = Number(store.getMeta('auth_failures') ?? '0') + 1;
    store.setMeta('auth_failures', String(failures));
    if (failures >= AUTH_FAILURES_STOP) store.setMeta('auth_state', 'failed');
    return true;
  }
  return error.kind === 'rate' || error.kind === 'unavailable';
}

export function writeScope(store: Store): boolean {
  return store.getMeta('write_scope') === '1';
}
