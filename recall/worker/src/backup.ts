/**
 * The archive's backup to the owner's Dropbox (../../docs/design.md §7.2, contracts/recall-archive-v1 §3): the
 * connection and the alarm's archive pass.
 *
 * The connection. The owner gives the App key of their own App-folder Dropbox app (ConnectDropboxBackup): RecallState
 * keeps it with the SHA-256 of a fresh `state` and a PKCE verifier for DROPBOX_CONNECT_MS, and the browser goes to
 * Dropbox. Dropbox sends it back to GET /api/dropbox/callback (behind Access, http.ts), which checks the state once,
 * exchanges the code with the verifier for a refresh token and reads the account's display name. The refresh token
 * stays in meta: no answer carries it, nothing logs it. Access tokens live in the object's memory only (AccessSession)
 * and are refreshed when they near their end. DisconnectDropboxBackup revokes the token at Dropbox and forgets it;
 * Dropbox refusing the refresh token (the owner removed the app) disconnects as well. A connection is a `target`
 * (the account and the App key): a new target writes the whole archive again, the same target goes on where it stopped.
 *
 * The pass (once per alarm, while connected): a scan step (archive.ts); then, with the subrequests of
 * ARCHIVE_SUBREQUESTS and ARCHIVE_PASS_MS of wall time: on a new target, a look at the folder's state.json (another
 * feed's archive stops it: `dropbox_other_feed`) and VERSION; then the dirty days, newest first, each after the blobs
 * its lines refer to (read from R2, checked against their digests, written once with `add`, recorded in
 * archive_blobs); then state.json with the scanned seq. Everything is idempotent: what was written is recorded, a day
 * is written only when its bytes changed, and writing the same bytes again changes nothing at Dropbox. Nothing is ever
 * deleted at Dropbox. A failure records its code and waits (ARCHIVE_RETRY_FIRST_MS doubled up to ARCHIVE_RETRY_MAX_MS,
 * or Dropbox's Retry-After). Logs hold codes only.
 *
 * What the pass records is also the ledger the retention window trusts (retention.ts, archiveConfirmations): a blob in
 * archive_blobs for this target with Dropbox's content hash (a blob whose path held another file is recorded without
 * one), a day written since its last change, and state.json's seq. A text retention moved out of Cloudflare has no R2
 * object: a pass skips its blob (the archive that confirmed it holds it; a new target gets its line without it).
 */
import { constantTimeEqual } from '@ziyixi/edge-auth';
import { create } from '@ziyixi/proto/protobuf';
import { DropboxBackupSchema, type DropboxBackup } from '@ziyixi/proto/recall/ui/v1/status_pb';
import { anyDirty, dayPath, dirtyDays, renderDay, scannedSeq, scanStep, stateText, VERSION_TEXT, type DayBlob } from './archive.ts';
import { blobKey, sha256Hex } from './blobs.ts';
import {
  accountName,
  authorizeUrl,
  contentHash,
  downloadFile,
  DropboxError,
  exchangeCode,
  refreshAccess,
  revokeToken,
  uploadFile,
  type DropboxEndpoints,
  type Fetcher,
} from './dropbox.ts';
import { behindCount, oldestUnsynced } from './feed.ts';
import {
  ARCHIVE_PASS_MS,
  ARCHIVE_RENDER_MAX,
  ARCHIVE_RETRY_FIRST_MS,
  ARCHIVE_RETRY_MAX_MS,
  ARCHIVE_SCAN_ROWS,
  ARCHIVE_SUBREQUESTS,
  DROPBOX_TIMEOUT_MS,
  DROPBOX_TOKEN_MARGIN_MS,
  SECOND,
} from './limits.ts';
import { time } from './model.ts';
import type { Store } from './store.ts';

/** The path of the callback Dropbox sends the browser back to. */
export const CALLBACK_PATH = '/api/dropbox/callback';
/** A Dropbox App key: lower-case letters and digits. */
export const APP_KEY = /^[a-z0-9]{8,32}$/;

const KEY = {
  appKey: 'dropbox_app_key',
  refresh: 'dropbox_refresh_token',
  name: 'dropbox_account_name',
  connected: 'dropbox_connected_ms',
  pending: 'dropbox_pending',
  target: 'archive_target',
  checked: 'archive_checked',
  version: 'archive_version',
  synced: 'archive_seq',
  upload: 'archive_upload_ms',
  error: 'archive_error',
  retry: 'archive_retry_ms',
  failures: 'archive_failures',
} as const;

/** The access token in the object's memory, and when it ends (the real clock). */
export interface AccessSession {
  token: string | null;
  expiresAt: number;
}

export interface BackupContext {
  readonly store: Store;
  readonly bucket: R2Bucket;
  readonly fetch: Fetcher;
  readonly endpoints: DropboxEndpoints;
  /** The call's time (the tests' clock under DEV_MANUAL_ALARMS); wall-time bounds read Date.now(). */
  readonly now: number;
  readonly transact: <T>(fn: () => T) => T;
  /** recall's public host: the redirect URI's and state.json's origin. */
  readonly host: string;
  readonly session: AccessSession;
}

/** What one pass did: nothing to do (or not connected), everything written, work left, or a failure's wait. */
export type PassResult = { readonly state: 'idle' | 'done' | 'more' } | { readonly state: 'retry'; readonly at: number };

interface Connection {
  readonly appKey: string;
  readonly refreshToken: string;
  readonly target: string;
}

/** The connection, or null when recall holds no refresh token. */
function connection(store: Store): Connection | null {
  const refreshToken = store.getMeta(KEY.refresh);
  const appKey = store.getMeta(KEY.appKey);
  const target = store.getMeta(KEY.target);
  return refreshToken === null || appKey === null || target === null ? null : { appKey, refreshToken, target };
}

export function connected(store: Store): boolean {
  return store.getMeta(KEY.refresh) !== null;
}

/** Every change up to this seq is in Dropbox (0 before the target's first state.json). */
export function syncedSeq(store: Store): number {
  return Number(store.getMeta(KEY.synced) ?? '0');
}

/**
 * What retention may trust (retention.ts): the connection's target, whose archive_blobs rows confirm blobs, and the seq
 * up to which state.json vouches for every change; null while not connected or while the last attempt failed (it
 * retries by itself), when nothing leaves Cloudflare.
 */
export function archiveConfirmations(store: Store): { readonly target: string; readonly syncedSeq: number } | null {
  const conn = connection(store);
  if (conn === null || store.getMeta(KEY.failures) !== null || !stateWritten(store)) return null;
  return { target: conn.target, syncedSeq: syncedSeq(store) };
}

/** Why retention removes nothing now: the backup not connected, or failing; '' while it may. */
export function retentionPause(store: Store): '' | 'dropbox_not_connected' | 'dropbox_failing' {
  if (!connected(store)) return 'dropbox_not_connected';
  return store.getMeta(KEY.failures) !== null ? 'dropbox_failing' : '';
}

/** Whether the target holds a state.json of this store yet. */
function stateWritten(store: Store): boolean {
  return store.getMeta(KEY.synced) !== null;
}

/** The redirect URI the owner registers in their Dropbox app. */
export function redirectUri(host: string): string {
  return `https://${host}${CALLBACK_PATH}`;
}

// ---- the connection -------------------------------------------------------------------------------------------------

interface Pending {
  readonly state_sha256: string;
  readonly verifier: string;
  readonly app_key: string;
  readonly expires_ms: number;
}

function readPending(store: Store): Pending | null {
  try {
    const value = JSON.parse(store.getMeta(KEY.pending) ?? 'null') as Partial<Pending> | null;
    if (value === null || typeof value.state_sha256 !== 'string' || typeof value.verifier !== 'string' || typeof value.app_key !== 'string' || typeof value.expires_ms !== 'number') return null;
    return value as Pending;
  } catch {
    return null;
  }
}

/**
 * Keeps a connection the owner starts (inside the caller's transaction) and answers the authorization URL; a new one
 * replaces one not finished.
 */
export function startConnect(
  store: Store,
  endpoints: DropboxEndpoints,
  host: string,
  input: { readonly appKey: string; readonly state: string; readonly stateSha256: string; readonly verifier: string; readonly challenge: string; readonly expiresMs: number },
): string {
  const pending: Pending = { state_sha256: input.stateSha256, verifier: input.verifier, app_key: input.appKey, expires_ms: input.expiresMs };
  store.setMeta(KEY.pending, JSON.stringify(pending));
  return authorizeUrl(endpoints, { appKey: input.appKey, challenge: input.challenge, redirectUri: redirectUri(host), state: input.state });
}

export type ConnectOutcome = 'connected' | 'denied' | 'expired' | 'failed';

/** A new target writes everything again: every day dirty, the folder checked again, VERSION and state.json again. */
function resetTarget(store: Store, target: string): void {
  store.run(`UPDATE archive_days SET dirty = 1, content_hash = NULL WHERE dirty = 0 OR content_hash IS NOT NULL`);
  store.deleteMeta(KEY.checked, KEY.version, KEY.synced);
  store.setMeta(KEY.target, target);
}

/** Forgets the connection (the App key and what was written stay, for the same target again). */
function forget(store: Store): void {
  store.deleteMeta(KEY.refresh, KEY.name, KEY.connected, KEY.pending, KEY.retry, KEY.failures);
}

/**
 * GET /api/dropbox/callback?code=…&state=… (or `error=…` when the owner declined): the state checked once against the
 * connection the owner started, the code exchanged with its verifier, the refresh token kept.
 */
export async function finishConnect(ctx: BackupContext, search: string): Promise<ConnectOutcome> {
  const { store } = ctx;
  const params = new URLSearchParams(search);
  const state = params.get('state') ?? '';
  const pending = readPending(store);
  if (pending === null || pending.expires_ms <= ctx.now || state === '' || state.length > 256) return 'expired';
  if (!constantTimeEqual(await sha256Hex(new TextEncoder().encode(state)), pending.state_sha256)) return 'expired';
  ctx.transact(() => {
    store.deleteMeta(KEY.pending);
  });
  if (params.has('error')) return 'denied';
  const code = params.get('code') ?? '';
  if (code === '' || code.length > 1024) return 'failed';
  let exchanged: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    exchanged = await exchangeCode(ctx.fetch, ctx.endpoints, { appKey: pending.app_key, code, verifier: pending.verifier, redirectUri: redirectUri(ctx.host) });
  } catch (error) {
    console.log(JSON.stringify({ event: 'dropbox_connect', code: error instanceof DropboxError ? error.code : 'dropbox_failed' }));
    return 'failed';
  }
  let name = '';
  try {
    name = await accountName(ctx.fetch, ctx.endpoints, exchanged.access.token);
  } catch {
    // The name only labels the connection.
  }
  const target = `${exchanged.accountId} ${pending.app_key}`;
  ctx.transact(() => {
    if (store.getMeta(KEY.target) !== target) resetTarget(store, target);
    store.setMeta(KEY.appKey, pending.app_key);
    store.setMeta(KEY.refresh, exchanged.refreshToken);
    store.setMeta(KEY.name, name);
    store.setMeta(KEY.connected, String(ctx.now));
    store.deleteMeta(KEY.error, KEY.retry, KEY.failures);
  });
  ctx.session.token = exchanged.access.token;
  ctx.session.expiresAt = Date.now() + exchanged.access.expiresInMs;
  return 'connected';
}

/** The subrequests and the wall time a pass (or a disconnection) may still spend. */
class Budget {
  private left: number;
  private readonly deadline: number;

  constructor(subrequests: number, ms: number) {
    this.left = subrequests;
    this.deadline = Date.now() + ms;
  }

  has(count: number): boolean {
    return this.left >= count && Date.now() < this.deadline;
  }

  spend(count = 1): void {
    this.left -= count;
  }
}

/** The access token, refreshed when it is missing or near its end. */
async function accessToken(ctx: BackupContext, conn: Connection, budget: Budget): Promise<string> {
  const { session } = ctx;
  if (session.token !== null && session.expiresAt - DROPBOX_TOKEN_MARGIN_MS > Date.now()) return session.token;
  budget.spend();
  const access = await refreshAccess(ctx.fetch, ctx.endpoints, { appKey: conn.appKey, refreshToken: conn.refreshToken });
  session.token = access.token;
  session.expiresAt = Date.now() + access.expiresInMs;
  return access.token;
}

/** Revokes the token at Dropbox (best effort) and forgets the connection. */
export async function disconnect(ctx: BackupContext): Promise<void> {
  const conn = connection(ctx.store);
  if (conn === null) return;
  let revoked = false;
  try {
    const token = await accessToken(ctx, conn, new Budget(2, 2 * DROPBOX_TIMEOUT_MS));
    await revokeToken(ctx.fetch, ctx.endpoints, token);
    revoked = true;
  } catch (error) {
    // A refresh token Dropbox no longer accepts is revoked already.
    revoked = error instanceof DropboxError && error.code === 'dropbox_refused';
  }
  ctx.session.token = null;
  ctx.transact(() => {
    forget(ctx.store);
    if (revoked) ctx.store.deleteMeta(KEY.error);
    else ctx.store.setMeta(KEY.error, JSON.stringify({ code: 'dropbox_revoke_failed', ms: ctx.now }));
  });
}

// ---- the pass ------------------------------------------------------------------------------------------------------

/** A failure of recall's own side during a pass (R2), with its code. */
class PassFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const utf8 = (text: string) => new TextEncoder().encode(text);

async function put(ctx: BackupContext, token: string, path: string, bytes: Uint8Array, mode: 'add' | 'overwrite', hash?: string): Promise<string> {
  const digest = hash ?? (await contentHash(bytes));
  await uploadFile(ctx.fetch, ctx.endpoints, token, { path: `/${path}`, bytes, mode, contentHash: digest });
  return digest;
}

/** The folder's state.json, when it has one, must be of this feed: an archive holds one feed only. */
async function checkFolder(ctx: BackupContext, token: string): Promise<void> {
  const bytes = await downloadFile(ctx.fetch, ctx.endpoints, token, '/state.json');
  if (bytes === null) return;
  let feed: unknown = null;
  try {
    feed = (JSON.parse(new TextDecoder().decode(bytes)) as { feed_id?: unknown }).feed_id;
  } catch {
    // Not an archive's state.json: never written over.
  }
  if (feed !== ctx.store.feedId()) throw new DropboxError('dropbox_other_feed');
}

/**
 * The blobs a day's lines refer to, each written once. 'more': the budget ran out; 'again': a blob's record was
 * deleted since the day was read (render it again). A live record whose object R2 lacks or holds with other bytes is
 * a loss recall reports (blob_missing, blob_corrupt) without holding the archive back.
 */
async function writeBlobs(ctx: BackupContext, conn: Connection, token: string, blobs: readonly DayBlob[], budget: Budget, warn: (code: string) => void): Promise<'ok' | 'more' | 'again'> {
  const { store } = ctx;
  for (const blob of blobs) {
    if (store.one(`SELECT 1 AS x FROM archive_blobs WHERE path = ? AND target = ?`, blob.path, conn.target) !== undefined) continue;
    // The blob's read and write, and its day's file after it.
    if (!budget.has(3)) return 'more';
    budget.spend();
    let bytes: Uint8Array | null;
    try {
      const object = await ctx.bucket.get(blobKey(blob.path));
      bytes = object === null ? null : new Uint8Array(await object.arrayBuffer());
    } catch {
      throw new PassFailure('r2_unavailable');
    }
    if (bytes === null || bytes.byteLength !== blob.size || (await sha256Hex(bytes)) !== blob.sha256) {
      const live = store.one(`SELECT 1 AS x FROM documents d JOIN pages p ON p.rowid = d.page_rowid WHERE d.blob_path = ?`, blob.path) !== undefined;
      if (!live) return 'again';
      const code = bytes === null ? 'blob_missing' : 'blob_corrupt';
      ctx.transact(() => {
        store.pushError(code);
      });
      console.log(JSON.stringify({ event: 'archive', code }));
      continue;
    }
    budget.spend();
    let hash = await contentHash(bytes);
    try {
      await put(ctx, token, `blobs/${blob.path}`, bytes, 'add', hash);
    } catch (error) {
      // Another file holds the path: left as it is (a blob is never written over), and said. Recorded without a hash,
      // so it is not tried again, and retention never takes the text for archived.
      if (!(error instanceof DropboxError && error.code === 'dropbox_conflict')) throw error;
      warn('dropbox_conflict');
      hash = '';
    }
    ctx.transact(() => {
      store.run(
        `INSERT INTO archive_blobs (path, target, content_hash) VALUES (?, ?, ?) ON CONFLICT (path) DO UPDATE SET target = excluded.target, content_hash = excluded.content_hash`,
        blob.path,
        conn.target,
        hash,
      );
      store.setMeta(KEY.upload, String(ctx.now));
    });
  }
  return 'ok';
}

/** Records a failed pass and when to try again; `dropbox_refused` disconnects. */
function failed(ctx: BackupContext, error: unknown): PassResult {
  const { store } = ctx;
  const code = error instanceof DropboxError || error instanceof PassFailure ? error.code : 'archive_failed';
  const failures = Number(store.getMeta(KEY.failures) ?? '0') + 1;
  const backoff = Math.min(ARCHIVE_RETRY_MAX_MS, ARCHIVE_RETRY_FIRST_MS * 2 ** Math.min(failures - 1, 16));
  const asked = error instanceof DropboxError ? error.retryAfterMs : null;
  const at = ctx.now + (asked === null ? backoff : Math.min(ARCHIVE_RETRY_MAX_MS, Math.max(asked, SECOND)));
  if (code === 'dropbox_token' || code === 'dropbox_refused') ctx.session.token = null;
  ctx.transact(() => {
    store.setMeta(KEY.error, JSON.stringify({ code, ms: ctx.now }));
    store.pushError(code);
    if (code === 'dropbox_refused') forget(store);
    else {
      store.setMeta(KEY.failures, String(failures));
      store.setMeta(KEY.retry, String(at));
    }
  });
  console.log(JSON.stringify({ event: 'archive', code }));
  return code === 'dropbox_refused' ? { state: 'idle' } : { state: 'retry', at };
}

/** One archive pass (the alarm's, one at a time with uploads); see the file's comment. */
export async function archivePass(ctx: BackupContext): Promise<PassResult> {
  const { store } = ctx;
  const conn = connection(store);
  if (conn === null) return { state: 'idle' };
  const retryAt = Number(store.getMeta(KEY.retry) ?? '0');
  if (retryAt > ctx.now) return { state: 'retry', at: retryAt };
  if (!ctx.transact(() => scanStep(store, ARCHIVE_SCAN_ROWS))) return { state: 'more' };
  const scanned = scannedSeq(store);
  const needCheck = store.getMeta(KEY.checked) !== conn.target;
  const needVersion = store.getMeta(KEY.version) !== conn.target;
  if (!needCheck && !needVersion && !anyDirty(store) && stateWritten(store) && syncedSeq(store) >= scanned) return { state: 'done' };
  const budget = new Budget(ARCHIVE_SUBREQUESTS, ARCHIVE_PASS_MS);
  const warnings: string[] = [];
  const warn = (code: string) => {
    warnings.push(code);
    ctx.transact(() => {
      store.pushError(code);
    });
  };
  try {
    const token = await accessToken(ctx, conn, budget);
    if (needCheck) {
      budget.spend();
      await checkFolder(ctx, token);
      ctx.transact(() => {
        store.setMeta(KEY.checked, conn.target);
      });
    }
    if (needVersion) {
      budget.spend();
      await put(ctx, token, 'VERSION', utf8(VERSION_TEXT), 'overwrite');
      ctx.transact(() => {
        store.setMeta(KEY.version, conn.target);
        store.setMeta(KEY.upload, String(ctx.now));
      });
    }
    let rendered = 0;
    for (let days = dirtyDays(store, 8); days.length > 0; days = dirtyDays(store, 8)) {
      for (const day of days) {
        if (!budget.has(1) || rendered >= ARCHIVE_RENDER_MAX) return { state: 'more' };
        const file = renderDay(store, day);
        rendered += file.count;
        const blobs = await writeBlobs(ctx, conn, token, file.blobs, budget, warn);
        if (blobs !== 'ok') return { state: 'more' };
        const bytes = utf8(file.text);
        const hash = await contentHash(bytes);
        // A day written before with these bytes, or never written and empty, needs no call.
        const upload = hash !== day.content_hash && !(file.count === 0 && day.content_hash === null);
        if (upload) {
          if (!budget.has(1)) return { state: 'more' };
          budget.spend();
          await put(ctx, token, dayPath(day.day), bytes, 'overwrite', hash);
        }
        ctx.transact(() => {
          store.run(`UPDATE archive_days SET dirty = 0, content_hash = ? WHERE day = ?`, upload ? hash : day.content_hash, day.day);
          if (upload) store.setMeta(KEY.upload, String(ctx.now));
        });
      }
    }
    if (!stateWritten(store) || syncedSeq(store) < scanned) {
      if (!budget.has(1)) return { state: 'more' };
      budget.spend();
      await put(ctx, token, 'state.json', utf8(stateText(store.feedId(), `https://${ctx.host}`, scanned, ctx.now)), 'overwrite');
      ctx.transact(() => {
        store.setMeta(KEY.synced, String(scanned));
        store.setMeta(KEY.upload, String(ctx.now));
      });
    }
    const left = warnings[warnings.length - 1] ?? null;
    ctx.transact(() => {
      store.deleteMeta(KEY.retry, KEY.failures);
      if (left === null) store.deleteMeta(KEY.error);
      else store.setMeta(KEY.error, JSON.stringify({ code: left, ms: ctx.now }));
    });
    return { state: 'done' };
  } catch (error) {
    return failed(ctx, error);
  }
}

// ---- the status ------------------------------------------------------------------------------------------------------

function readError(store: Store): { readonly code: string; readonly ms: number } | null {
  try {
    const value = JSON.parse(store.getMeta(KEY.error) ?? 'null') as { code?: unknown; ms?: unknown } | null;
    return value !== null && typeof value.code === 'string' && typeof value.ms === 'number' ? { code: value.code, ms: value.ms } : null;
  } catch {
    return null;
  }
}

const number = (value: string | null): number | null => (value === null ? null : Number(value));

/**
 * The lag ops-v1 watches: since when a change has waited for Dropbox, counted from the connection at the earliest (a
 * first upload of an old store is no lag); null when connected and nothing waits, or when not connected.
 */
export function waitingSince(store: Store): number | null {
  if (!connected(store)) return null;
  const oldest = oldestUnsynced(store, syncedSeq(store));
  return oldest === null ? null : Math.max(oldest, number(store.getMeta(KEY.connected)) ?? oldest);
}

/** DropboxBackup: a few meta rows, and while connected the changes not in Dropbox (counted up to BEHIND_COUNT_MAX). */
export function backupMessage(store: Store): DropboxBackup {
  const isConnected = connected(store);
  const synced = syncedSeq(store);
  const oldest = isConnected ? oldestUnsynced(store, synced) : null;
  const error = readError(store);
  return create(DropboxBackupSchema, {
    name: 'dropboxBackup',
    appKey: store.getMeta(KEY.appKey) ?? '',
    connected: isConnected,
    accountDisplayName: isConnected ? (store.getMeta(KEY.name) ?? '') : '',
    connectTime: time(isConnected ? number(store.getMeta(KEY.connected)) : null),
    lastUploadTime: time(number(store.getMeta(KEY.upload))),
    syncedSeq: synced,
    pendingCount: oldest === null ? 0 : behindCount(store, synced),
    oldestPendingTime: time(oldest),
    errorCode: error?.code ?? '',
    errorTime: time(error?.ms ?? null),
  });
}
