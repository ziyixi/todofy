/**
 * The machine tokens (../../docs/design.md §2.2): the bearer tokens of the machine routes, `ingest` (the extension's
 * uploads, write-only) and `export` (the change feed and its blobs, read-only; optional). The owner makes them in
 * 设置 → 插件口令 (RegenerateMachineToken). RecallState keeps only each token's SHA-256 in meta (`token_ingest`,
 * `token_export`: the current digest and when it was made, and the replaced one with the end of its grace), answers the
 * token itself once, in that response, and never stores, logs or answers it again.
 *
 * The Worker checks a bearer against these digests, kept in its memory for TOKEN_CACHE_MS (machine.ts), and against
 * the digests a Worker secret may hold (INGEST_TOKEN_SHA256 and the others, put by hand: they stay accepted), before
 * any other call. A regenerated token's predecessor works TOKEN_GRACE_MS more, or stops at once with revoke_previous.
 */
import { create } from '@ziyixi/proto/protobuf';
import { MachineTokenSchema, type MachineToken } from '@ziyixi/proto/recall/ui/v1/status_pb';
import { sha256Hex } from './blobs.ts';
import { TOKEN_GRACE_MS } from './limits.ts';
import { time } from './model.ts';
import type { Store } from './store.ts';

export type TokenRoute = 'ingest' | 'export';
export const TOKEN_ROUTES: readonly TokenRoute[] = ['ingest', 'export'];
export const NAMED_TOKEN_MAX = 16;
const NAMED_TOKEN_KEY = 'token_devices';
const TOKEN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface NamedToken {
  readonly id: string;
  readonly label: string;
  readonly digest: string;
  readonly created_ms: number;
}

/** A bounded list of independent upload credentials; no bearer bytes are stored. */
export function namedTokens(store: Store): NamedToken[] {
  const value: unknown = JSON.parse(store.getMeta(NAMED_TOKEN_KEY) ?? '[]');
  if (!Array.isArray(value) || value.length > NAMED_TOKEN_MAX) throw new Error('invalid named token list');
  return value as NamedToken[];
}

/** The UUID of a named token resource, or null for legacy/invalid names. */
export function namedTokenId(name: string): string | null {
  const id = name.startsWith('machineTokens/') ? name.slice('machineTokens/'.length) : '';
  return TOKEN_ID.test(id) ? id : null;
}

export function namedTokenMessage(stored: NamedToken): MachineToken {
  return create(MachineTokenSchema, { name: `machineTokens/${stored.id}`, label: stored.label, createTime: time(stored.created_ms) });
}

export function addNamedToken(store: Store, label: string, digest: string, now: number): MachineToken | null {
  const current = namedTokens(store);
  if (current.length >= NAMED_TOKEN_MAX) return null;
  const made: NamedToken = { id: crypto.randomUUID(), label, digest, created_ms: now };
  store.setMeta(NAMED_TOKEN_KEY, JSON.stringify([...current, made]));
  return namedTokenMessage(made);
}

export function deleteNamedToken(store: Store, id: string): boolean {
  const current = namedTokens(store);
  const kept = current.filter((token) => token.id !== id);
  if (kept.length === current.length) return false;
  store.setMeta(NAMED_TOKEN_KEY, JSON.stringify(kept));
  return true;
}

/** What RecallState keeps of a route's token. */
interface StoredToken {
  readonly digest: string;
  readonly created_ms: number;
  readonly previous: string | null;
  readonly previous_until_ms: number | null;
}

/** The digests each route accepts. */
export type RouteDigests = Readonly<Record<TokenRoute, readonly string[]>>;

const DIGEST = /^[0-9a-f]{64}$/;

/** The route a resource name `machineTokens/{route}` names, or null. */
export function tokenRoute(name: string): TokenRoute | null {
  const route = name.startsWith('machineTokens/') ? name.slice('machineTokens/'.length) : '';
  return route === 'ingest' || route === 'export' ? route : null;
}

function readToken(store: Store, route: TokenRoute): StoredToken | null {
  try {
    const value = JSON.parse(store.getMeta(`token_${route}`) ?? 'null') as Partial<StoredToken> | null;
    if (value === null || typeof value.digest !== 'string' || !DIGEST.test(value.digest) || typeof value.created_ms !== 'number') return null;
    const previous = typeof value.previous === 'string' && DIGEST.test(value.previous) && typeof value.previous_until_ms === 'number' ? value.previous : null;
    return { digest: value.digest, created_ms: value.created_ms, previous, previous_until_ms: previous === null ? null : (value.previous_until_ms ?? null) };
  } catch {
    // A value this code did not write: no token.
    return null;
  }
}

/** A new token of a route: its prefix (which the scrubber and secret scanners know) and 32 random bytes, base64url. */
export function newToken(route: TokenRoute): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `recall_${route}_${base64}`;
}

/** The digest a bearer is compared by: the SHA-256 of the token's UTF-8, lower-case hex. */
export function tokenDigest(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token));
}

/**
 * Stores a new token's digest (inside the caller's transaction): the current one becomes the previous, accepted until
 * TOKEN_GRACE_MS from now, unless `revokePrevious` (a leak), which drops it and any older previous.
 */
export function storeToken(store: Store, route: TokenRoute, digest: string, now: number, revokePrevious: boolean): void {
  const current = readToken(store, route);
  const keep = !revokePrevious && current !== null;
  const stored: StoredToken = { digest, created_ms: now, previous: keep ? current.digest : null, previous_until_ms: keep ? now + TOKEN_GRACE_MS : null };
  store.setMeta(`token_${route}`, JSON.stringify(stored));
}

/** Changes only a display label; authentication digests and their lifetimes stay untouched. */
export function renameToken(store: Store, name: string, label: string): boolean {
  const route = tokenRoute(name);
  if (route !== null) {
    store.setMeta(`token_label_${route}`, label);
    return true;
  }
  const id = namedTokenId(name);
  if (id === null) return false;
  const current = namedTokens(store);
  if (!current.some((token) => token.id === id)) return false;
  store.setMeta(NAMED_TOKEN_KEY, JSON.stringify(current.map((token) => token.id === id ? { ...token, label } : token)));
  return true;
}

/** Forgets a route's token and its previous (inside the caller's transaction); false when there was none. */
export function deleteToken(store: Store, route: TokenRoute): boolean {
  if (store.getMeta(`token_${route}`) === null) return false;
  store.deleteMeta(`token_${route}`);
  return true;
}

/** Drops each previous digest whose grace has ended (the daily alarm; heldDigests never answers one). */
export function pruneTokens(store: Store, now: number): void {
  for (const route of TOKEN_ROUTES) {
    const token = readToken(store, route);
    if (token === null || token.previous === null || (token.previous_until_ms ?? 0) > now) continue;
    store.setMeta(`token_${route}`, JSON.stringify({ digest: token.digest, created_ms: token.created_ms, previous: null, previous_until_ms: null }));
  }
}

/** The digests RecallState holds for each route: the current, and the previous while its grace lasts. */
export function heldDigests(store: Store, now: number): RouteDigests {
  const of = (route: TokenRoute): string[] => {
    const token = readToken(store, route);
    if (token === null) return [];
    return token.previous !== null && (token.previous_until_ms ?? 0) > now ? [token.digest, token.previous] : [token.digest];
  };
  return { ingest: [...of('ingest'), ...namedTokens(store).map((token) => token.digest)], export: of('export') };
}

/** The configured Worker-secret digests of a route (current, then previous), lower-case hex only. */
export function secretDigests(
  env: Readonly<Partial<Record<'INGEST_TOKEN_SHA256' | 'INGEST_TOKEN_SHA256_PREVIOUS' | 'EXPORT_TOKEN_SHA256' | 'EXPORT_TOKEN_SHA256_PREVIOUS', string>>>,
  route: TokenRoute,
): string[] {
  const values = route === 'ingest' ? [env.INGEST_TOKEN_SHA256, env.INGEST_TOKEN_SHA256_PREVIOUS] : [env.EXPORT_TOKEN_SHA256, env.EXPORT_TOKEN_SHA256_PREVIOUS];
  return values.map((value) => (value ?? '').trim().toLowerCase()).filter((value) => DIGEST.test(value));
}

/** A route's MachineToken; `token` only in RegenerateMachineToken's response. */
export function tokenMessage(store: Store, route: TokenRoute, now: number, workerSecret: boolean, token = ''): MachineToken {
  const stored = readToken(store, route);
  const grace = stored !== null && stored.previous !== null && (stored.previous_until_ms ?? 0) > now ? stored.previous_until_ms : null;
  return create(MachineTokenSchema, {
    name: `machineTokens/${route}`,
    label: store.getMeta(`token_label_${route}`) ?? '',
    token,
    createTime: time(stored?.created_ms ?? null),
    previousExpireTime: time(grace),
    workerSecret,
  });
}
