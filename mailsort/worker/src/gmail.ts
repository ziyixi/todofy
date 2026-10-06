/**
 * The only code of the Worker that talks to Google (../../docs/design.md §2, the safety model). Every request is built
 * here and checked against a closed table of (method, host, path, query, body) shapes BEFORE fetch runs; anything
 * else throws GmailRefused and never leaves the isolate. The table is the whole of what mailsort may do to the owner's
 * mailbox:
 *
 *   token          POST  oauth2.googleapis.com/token                        refresh_token grant only
 *   profile        GET   /gmail/v1/users/me/profile?fields=historyId        the install-time cursor (no address read)
 *   history        GET   /gmail/v1/users/me/history                         messageAdded, labelAdded, labelRemoved
 *   messages_list  GET   /gmail/v1/users/me/messages?labelIds=INBOX&q=newer_than:2d   the resync after a lost cursor
 *   message_get    GET   /gmail/v1/users/me/messages/{id}                   format=full or metadata, fixed fields
 *   labels_list    GET   /gmail/v1/users/me/labels
 *   labels_create  POST  /gmail/v1/users/me/labels                          a name under "分拣/" (a path of up to
 *                                                                            three segments), or "分拣" itself
 *   labels_patch   PATCH /gmail/v1/users/me/labels/{owned id}               the name only, still under "分拣/"
 *   message_modify POST  /gmail/v1/users/me/messages/{id}/modify            exactly two shapes:
 *     classify: addLabelIds = [one owned label], removeLabelIds = [] or [INBOX], for a ledger row in `intended` or
 *               `applied` whose `archived` matches;
 *     undo:     removeLabelIds = [that owned label], addLabelIds = [] or [INBOX] (INBOX exactly when the row
 *               archived), for a ledger row in `undo_intended`.
 *
 * So there is no path to trash, untrash, delete, batchDelete, batchModify, send, drafts, filters, settings or
 * forwarding, and no way to touch UNREAD, STARRED, IMPORTANT, SPAM, TRASH, CATEGORY_* or a label mailsort does not own.
 * The OAuth grant is the second wall: gmail.readonly in shadow, gmail.modify in live, never https://mail.google.com/
 * (the only scope that can delete for good). test/gmail-guard.test.ts records every call a fake fetch receives and
 * checks it against an independent copy of this table, and throws random operations at the guard.
 *
 * Nothing here logs. Answers are read with a byte cap and parsed as JSON; their content is untrusted mail data.
 */
import { GOOGLE_TIMEOUT_MS, LABEL_DEPTH_MAX, LABEL_PREFIX, LABEL_ROOT, MESSAGE_MAX_BYTES, RESPONSE_MAX_BYTES, RESYNC_QUERY } from './limits.ts';

export const GMAIL_HOST = 'gmail.googleapis.com';
export const TOKEN_HOST = 'oauth2.googleapis.com';
const GMAIL_BASE = `https://${GMAIL_HOST}/gmail/v1/users/me`;
export const TOKEN_URL = `https://${TOKEN_HOST}/token`;

/** The two scopes mailsort ever asks for (deploy/mint-token.mjs). */
export const SCOPE_READONLY = 'https://www.googleapis.com/auth/gmail.readonly';
export const SCOPE_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';

/** The headers a metadata read asks for: what the pipeline reads, nothing else. */
export const METADATA_HEADERS = ['From', 'To', 'Delivered-To', 'Subject', 'List-Id', 'Message-ID', 'Authentication-Results'] as const;
/** The fields of a messages.get answer (`fields`): no raw body, no attachment data. */
export const MESSAGE_FIELDS = 'id,threadId,labelIds,snippet,internalDate,payload(mimeType,headers,body(size,data),parts(mimeType,headers,body(size,data),parts(mimeType,headers,body(size,data),parts(mimeType,body(size,data)))))';
export const HISTORY_TYPES = ['messageAdded', 'labelAdded', 'labelRemoved'] as const;

/** Message IDs as Gmail writes them (hex). */
const MESSAGE_ID = /^[0-9a-f]{6,32}$/;

/** Whether `id` is a message ID the guard accepts (history records are untrusted input too). */
export function isMessageId(id: unknown): id is string {
  return typeof id === 'string' && MESSAGE_ID.test(id);
}
/** User label IDs as Gmail writes them; system labels (INBOX, UNREAD, ...) never match. */
const USER_LABEL_ID = /^Label_[0-9]{1,24}$/;
/** Whether `id` is a user label (the owner's or mailsort's), not a system one such as INBOX, UNREAD or CATEGORY_*. */
export function isUserLabelId(id: string): boolean {
  return USER_LABEL_ID.test(id);
}
const DIGITS = /^[0-9]{1,24}$/;
const PAGE_TOKEN = /^[0-9A-Za-z_-]{1,256}$/;
/** Whether `text` has a control character (C0 or DEL). */
export function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export type GmailOp = 'token' | 'profile' | 'history' | 'messages_list' | 'message_get' | 'labels_list' | 'labels_create' | 'labels_patch' | 'message_modify';

/** A ledger row as the guard needs it (store.ts LedgerState). */
export interface LedgerView {
  readonly state: 'intended' | 'applied' | 'failed' | 'undo_intended' | 'undone';
  readonly archived: boolean;
}

/** What the guard knows of the app's own state: the labels it owns and its ledger. */
export interface Ownership {
  /** Gmail IDs of the labels mailsort owns (linked labels whose name starts with "分拣/"). */
  ownedLabelIds(): ReadonlySet<string>;
  /** The ledger row that adds `labelId` to `messageId`, or null. */
  ledger(messageId: string, labelId: string): LedgerView | null;
}

/** A request the closed table refuses. Thrown before fetch; the message is a fixed code. */
export class GmailRefused extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`gmail request refused: ${code}`);
    this.code = code;
    this.name = 'GmailRefused';
  }
}

/** One request to Google, as the guard sees it. */
export interface GoogleRequest {
  readonly method: string;
  readonly url: string;
  /** The body text: JSON for Gmail, form-encoded for the token endpoint. */
  readonly body?: string;
}

function refuse(code: string): never {
  throw new GmailRefused(code);
}

/** The query as name -> values, refusing any name not in `allowed`. */
function query(url: URL, allowed: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [name, value] of url.searchParams) {
    if (!allowed.includes(name)) refuse('query_param');
    out.set(name, [...(out.get(name) ?? []), value]);
  }
  return out;
}

function single(params: Map<string, string[]>, name: string): string | undefined {
  const values = params.get(name);
  if (values === undefined) return undefined;
  if (values.length !== 1) refuse('query_repeated');
  return values[0];
}

function jsonBody(body: string | undefined, keys: readonly string[]): Record<string, unknown> {
  if (body === undefined) refuse('body_missing');
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    refuse('body_json');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) refuse('body_shape');
  // The check is of the parsed value, but the text is what Google reads: only the canonical text of that value may go
  // out. A duplicate key (JSON.parse keeps the last one; a server might keep the first) or any other spelling of a
  // different meaning is refused. The client sends JSON.stringify of plain objects, which is canonical.
  if (JSON.stringify(value) !== body) refuse('body_not_canonical');
  for (const key of Object.keys(value)) if (!keys.includes(key)) refuse('body_key');
  return value as Record<string, unknown>;
}

function labelList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item): item is string => typeof item === 'string')) refuse('label_list');
  if (new Set(value).size !== value.length) refuse('label_duplicate');
  return value;
}

/**
 * A Gmail label name of this app: under the prefix, a path of 1 to LABEL_DEPTH_MAX segments (a Gmail nested label,
 * `分拣/开发/CI通知`), each non-empty without surrounding spaces, and no control characters. A label of this app or a
 * parent that groups some (`分拣/开发`); only a linked label of the app's store is ever written to a mail.
 */
export function ownedName(name: unknown): name is string {
  if (typeof name !== 'string' || !name.startsWith(LABEL_PREFIX) || name.length > 225 || hasControl(name)) return false;
  const segments = name.slice(LABEL_PREFIX.length).split('/');
  return segments.length <= LABEL_DEPTH_MAX && segments.every((segment) => segment !== '' && segment === segment.trim());
}

function owned(labelId: string, ownership: Ownership): void {
  if (!USER_LABEL_ID.test(labelId) || !ownership.ownedLabelIds().has(labelId)) refuse('label_not_owned');
}

/** The modify body's two allowed shapes (the table above). */
function checkModify(messageId: string, body: string | undefined, ownership: Ownership): void {
  const value = jsonBody(body, ['addLabelIds', 'removeLabelIds']);
  const add = labelList(value['addLabelIds']);
  const remove = labelList(value['removeLabelIds']);
  const inboxOnly = (list: string[]) => list.length === 0 || (list.length === 1 && list[0] === 'INBOX');
  if (add.length === 1 && inboxOnly(remove)) {
    // classify
    const label = add[0] ?? '';
    owned(label, ownership);
    const row = ownership.ledger(messageId, label);
    if (row === null || (row.state !== 'intended' && row.state !== 'applied')) refuse('no_intent');
    if (row.archived !== (remove.length === 1)) refuse('archive_mismatch');
    return;
  }
  if (remove.length === 1 && inboxOnly(add)) {
    // undo
    const label = remove[0] ?? '';
    owned(label, ownership);
    const row = ownership.ledger(messageId, label);
    if (row === null || row.state !== 'undo_intended') refuse('no_undo_intent');
    if (row.archived !== (add.length === 1)) refuse('archive_mismatch');
    return;
  }
  refuse('modify_shape');
}

/**
 * The operation `request` is, or GmailRefused: the closed table. Pure (no I/O), so the tests can call it with any
 * input; GmailClient calls it before every fetch.
 */
export function checkRequest(request: GoogleRequest, ownership: Ownership): GmailOp {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    refuse('url');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.hash !== '') refuse('url');
  // A raw URL with dot segments or an encoded slash could mean another path to the server than to this check.
  if (/%2f|%2e|\/\.\.?(\/|$)|\/\//i.test(request.url.slice(url.origin.length))) refuse('url_path');
  const method = request.method.toUpperCase();
  const path = url.pathname;

  if (url.host === TOKEN_HOST) {
    if (method !== 'POST' || path !== '/token' || url.search !== '') refuse('token');
    const form = new URLSearchParams(request.body ?? '');
    const names = [...form.keys()].sort().join(',');
    if (names !== 'client_id,client_secret,grant_type,refresh_token' || form.get('grant_type') !== 'refresh_token') refuse('token_body');
    return 'token';
  }
  if (url.host !== GMAIL_HOST) refuse('host');
  if (!path.startsWith('/gmail/v1/users/me/')) refuse('path');
  const rest = path.slice('/gmail/v1/users/me/'.length).split('/');

  if (method === 'GET' && rest.length === 1 && rest[0] === 'profile') {
    const params = query(url, ['fields']);
    if (single(params, 'fields') !== 'historyId') refuse('profile_fields');
    if (request.body !== undefined) refuse('body');
    return 'profile';
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'history') {
    const params = query(url, ['startHistoryId', 'historyTypes', 'maxResults', 'pageToken', 'labelId']);
    if (!DIGITS.test(single(params, 'startHistoryId') ?? '')) refuse('history_start');
    const types = params.get('historyTypes') ?? [];
    if (types.length === 0 || new Set(types).size !== types.length || !types.every((type) => (HISTORY_TYPES as readonly string[]).includes(type))) refuse('history_types');
    const max = Number(single(params, 'maxResults') ?? '');
    if (!Number.isInteger(max) || max < 1 || max > 500) refuse('history_max');
    const token = single(params, 'pageToken');
    if (token !== undefined && !PAGE_TOKEN.test(token)) refuse('page_token');
    const label = single(params, 'labelId');
    if (label !== undefined && label !== 'INBOX') refuse('history_label');
    if (request.body !== undefined) refuse('body');
    return 'history';
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'messages') {
    const params = query(url, ['labelIds', 'q', 'maxResults', 'pageToken']);
    if (single(params, 'labelIds') !== 'INBOX' || single(params, 'q') !== RESYNC_QUERY) refuse('list_query');
    const max = Number(single(params, 'maxResults') ?? '');
    if (!Number.isInteger(max) || max < 1 || max > 100) refuse('list_max');
    const token = single(params, 'pageToken');
    if (token !== undefined && !PAGE_TOKEN.test(token)) refuse('page_token');
    if (request.body !== undefined) refuse('body');
    return 'messages_list';
  }
  if (method === 'GET' && rest.length === 2 && rest[0] === 'messages') {
    if (!MESSAGE_ID.test(rest[1] ?? '')) refuse('message_id');
    const params = query(url, ['format', 'metadataHeaders', 'fields']);
    const format = single(params, 'format');
    const headers = params.get('metadataHeaders') ?? [];
    if (format === 'full') {
      if (headers.length > 0) refuse('metadata_headers');
    } else if (format === 'metadata') {
      if (headers.length === 0 || new Set(headers).size !== headers.length || !headers.every((name) => (METADATA_HEADERS as readonly string[]).includes(name))) refuse('metadata_headers');
    } else {
      refuse('format');
    }
    if (single(params, 'fields') !== MESSAGE_FIELDS) refuse('message_fields');
    if (request.body !== undefined) refuse('body');
    return 'message_get';
  }
  if (rest.length === 1 && rest[0] === 'labels') {
    if (method === 'GET') {
      if (url.search !== '' || request.body !== undefined) refuse('labels_list');
      return 'labels_list';
    }
    if (method === 'POST') {
      if (url.search !== '') refuse('query_param');
      const value = jsonBody(request.body, ['name', 'labelListVisibility', 'messageListVisibility']);
      // The prefix's own label too: Gmail nests `分拣/x` under it only when it exists.
      const name = value['name'];
      if (!(ownedName(name) || name === LABEL_ROOT) || value['labelListVisibility'] !== 'labelShow' || value['messageListVisibility'] !== 'show') refuse('labels_create');
      return 'labels_create';
    }
  }
  if (method === 'PATCH' && rest.length === 2 && rest[0] === 'labels') {
    if (url.search !== '') refuse('query_param');
    owned(rest[1] ?? '', ownership);
    const value = jsonBody(request.body, ['name']);
    if (!ownedName(value['name'])) refuse('labels_patch');
    return 'labels_patch';
  }
  if (method === 'POST' && rest.length === 3 && rest[0] === 'messages' && rest[2] === 'modify') {
    const id = rest[1] ?? '';
    if (!MESSAGE_ID.test(id)) refuse('message_id');
    if (url.search !== '') refuse('query_param');
    checkModify(id, request.body, ownership);
    return 'message_modify';
  }
  return refuse('not_in_table');
}

// ---- answers ----------------------------------------------------------------------------------------------------------

/** Why a Google call did not give an answer the pipeline can use. `code` is a safe error code (status page, logs). */
export type GoogleErrorKind = 'auth' | 'forbidden' | 'not_found' | 'rate' | 'unavailable' | 'bad_answer' | 'too_large';

export class GoogleError extends Error {
  readonly kind: GoogleErrorKind;
  readonly code: string;

  constructor(kind: GoogleErrorKind, code: string) {
    super(code);
    this.kind = kind;
    this.code = code;
    this.name = 'GoogleError';
  }
}

/** Reads at most `max` bytes of a body; null when it is longer (the rest is cancelled, never read). */
export async function readCapped(response: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel();
    return null;
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// ---- the client -------------------------------------------------------------------------------------------------------

export interface Credentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}

/** A Gmail message as the pipeline reads it (the fields of MESSAGE_FIELDS; mime.ts reads `payload`). */
export interface GmailMessage {
  readonly id: string;
  readonly threadId?: string;
  readonly labelIds?: readonly string[];
  readonly snippet?: string;
  readonly internalDate?: string;
  readonly payload?: unknown;
}

export interface HistoryPage {
  readonly history?: readonly HistoryRecord[];
  readonly nextPageToken?: string;
  readonly historyId?: string;
}

export interface HistoryRecord {
  readonly id: string;
  readonly messagesAdded?: readonly { readonly message: { readonly id: string; readonly threadId?: string; readonly labelIds?: readonly string[] } }[];
  readonly labelsAdded?: readonly { readonly message: { readonly id: string; readonly labelIds?: readonly string[] }; readonly labelIds: readonly string[] }[];
  readonly labelsRemoved?: readonly { readonly message: { readonly id: string; readonly labelIds?: readonly string[] }; readonly labelIds: readonly string[] }[];
}

export interface GmailLabel {
  readonly id: string;
  readonly name: string;
  readonly type?: string;
}

/** The access token and what the grant allows. */
export interface AccessToken {
  readonly token: string;
  readonly expiresAt: number;
  readonly writeScope: boolean;
}

export interface ClientOptions {
  readonly fetch: typeof fetch;
  readonly credentials: Credentials;
  readonly ownership: Ownership;
  /** Called once per request that passed the guard (the daily count, the subrequest budget). */
  readonly onCall: (op: GmailOp) => void;
  readonly now: () => number;
  /** A cached access token, if one is still valid. */
  readonly token?: AccessToken | null;
}

function assertObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new GoogleError('bad_answer', 'gmail_bad_answer');
  return value as Record<string, unknown>;
}

/**
 * Gmail for the pipeline and the owner API. One instance per alarm or request; it holds the access token it got.
 * Every method builds one GoogleRequest, which `send` checks with checkRequest before fetch.
 */
export class GmailClient {
  private token: AccessToken | null;
  private readonly options: ClientOptions;

  constructor(options: ClientOptions) {
    this.options = options;
    this.token = options.token ?? null;
  }

  /** The access token in use (cached by the caller between alarms), or null before the first refresh. */
  accessToken(): AccessToken | null {
    return this.token;
  }

  private async send(request: GoogleRequest, max: number, authorized: boolean): Promise<{ status: number; json: unknown; tooLarge: boolean }> {
    const op = checkRequest(request, this.options.ownership);
    this.options.onCall(op);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (authorized) headers['authorization'] = `Bearer ${(await this.ensureToken()).token}`;
    if (request.body !== undefined) headers['content-type'] = op === 'token' ? 'application/x-www-form-urlencoded' : 'application/json';
    let response: Response;
    try {
      response = await this.options.fetch(request.url, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        redirect: 'manual',
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      });
    } catch {
      throw new GoogleError('unavailable', `${op}_network`);
    }
    const bytes = await readCapped(response, max).catch(() => {
      throw new GoogleError('unavailable', `${op}_network`);
    });
    if (bytes === null) return { status: response.status, json: null, tooLarge: true };
    let json: unknown;
    try {
      json = bytes.byteLength === 0 ? null : JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      json = null;
    }
    return { status: response.status, json, tooLarge: false };
  }

  /** Maps a non-2xx Gmail answer to a GoogleError. */
  private failure(op: GmailOp, status: number, json: unknown): GoogleError {
    const reason = (() => {
      const error = (json as { error?: { errors?: { reason?: unknown }[]; status?: unknown } } | null)?.error;
      const first = error?.errors?.[0]?.reason;
      return typeof first === 'string' ? first : typeof error?.status === 'string' ? error.status : '';
    })();
    if (status === 401) return new GoogleError('auth', `${op}_401`);
    if (status === 429 || (status === 403 && /rate|quota/i.test(reason))) return new GoogleError('rate', `${op}_429`);
    if (status === 403) return new GoogleError('forbidden', `${op}_403`);
    if (status === 404) return new GoogleError('not_found', `${op}_404`);
    if (status >= 500) return new GoogleError('unavailable', `${op}_${String(status)}`);
    return new GoogleError('bad_answer', `${op}_${String(status)}`);
  }

  /** A valid access token: the cached one, or a refresh (POST /token). invalid_grant is `auth`. */
  async ensureToken(): Promise<AccessToken> {
    if (this.token !== null && this.token.expiresAt > this.options.now()) return this.token;
    const { clientId, clientSecret, refreshToken } = this.options.credentials;
    const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }).toString();
    const { status, json } = await this.send({ method: 'POST', url: TOKEN_URL, body }, RESPONSE_MAX_BYTES, false);
    if (status === 400 || status === 401) {
      const error = (json as { error?: unknown } | null)?.error;
      // invalid_grant: revoked, expired or replaced; invalid_client: the client was deleted. Both need the owner.
      if (error === 'invalid_grant' || error === 'invalid_client' || error === 'unauthorized_client') throw new GoogleError('auth', `token_${error}`);
    }
    if (status === 429) throw new GoogleError('rate', 'token_429');
    if (status < 200 || status >= 300) throw new GoogleError(status >= 500 ? 'unavailable' : 'bad_answer', `token_${String(status)}`);
    const value = assertObject(json);
    const token = value['access_token'];
    const expires = Number(value['expires_in'] ?? 3600);
    if (typeof token !== 'string' || token === '' || !Number.isFinite(expires)) throw new GoogleError('bad_answer', 'token_bad_answer');
    const scopes = typeof value['scope'] === 'string' ? value['scope'].split(' ') : [];
    this.token = { token, expiresAt: this.options.now() + Math.min(expires * 1000 - 60_000, 55 * 60_000), writeScope: scopes.includes(SCOPE_MODIFY) };
    return this.token;
  }

  private async getJson(op: GmailOp, url: string, max = RESPONSE_MAX_BYTES): Promise<unknown> {
    const { status, json, tooLarge } = await this.send({ method: 'GET', url }, max, true);
    if (tooLarge) throw new GoogleError('too_large', `${op}_too_large`);
    if (status < 200 || status >= 300) throw this.failure(op, status, json);
    return json;
  }

  private async write(op: GmailOp, method: string, url: string, body: unknown): Promise<unknown> {
    const { status, json, tooLarge } = await this.send({ method, url, body: JSON.stringify(body) }, RESPONSE_MAX_BYTES, true);
    if (tooLarge) throw new GoogleError('too_large', `${op}_too_large`);
    if (status < 200 || status >= 300) throw this.failure(op, status, json);
    return json;
  }

  /** The mailbox's current historyId (the install-time cursor; fields=historyId, so the address is never read). */
  async currentHistoryId(): Promise<string> {
    const value = assertObject(await this.getJson('profile', `${GMAIL_BASE}/profile?fields=historyId`));
    const id = value['historyId'];
    if (typeof id !== 'string' || !DIGITS.test(id)) throw new GoogleError('bad_answer', 'profile_bad_answer');
    return id;
  }

  /** One page of history after `start` (all three kinds; the pipeline filters). A lost cursor is `not_found`. */
  async history(start: string, pageToken: string | null, max: number): Promise<HistoryPage> {
    const params = new URLSearchParams({ startHistoryId: start });
    for (const type of HISTORY_TYPES) params.append('historyTypes', type);
    params.set('maxResults', String(max));
    if (pageToken !== null) params.set('pageToken', pageToken);
    return assertObject(await this.getJson('history', `${GMAIL_BASE}/history?${params.toString()}`));
  }

  /** The inbox's message IDs of the last two days (the resync after a lost cursor). */
  async recentInbox(max: number): Promise<string[]> {
    const params = new URLSearchParams({ labelIds: 'INBOX', q: RESYNC_QUERY, maxResults: String(max) });
    const value = assertObject(await this.getJson('messages_list', `${GMAIL_BASE}/messages?${params.toString()}`));
    const messages = Array.isArray(value['messages']) ? (value['messages'] as unknown[]) : [];
    return messages.flatMap((item) => {
      const id = (item as { id?: unknown } | null)?.id;
      return typeof id === 'string' && MESSAGE_ID.test(id) ? [id] : [];
    });
  }

  /**
   * A message with its first body parts (format=full), or with headers and snippet only (format=metadata) when the full
   * answer is larger than MESSAGE_MAX_BYTES. A deleted message is `not_found`.
   */
  async message(id: string): Promise<{ message: GmailMessage; metadataOnly: boolean }> {
    const full = new URLSearchParams({ format: 'full', fields: MESSAGE_FIELDS });
    try {
      return { message: assertObject(await this.getJson('message_get', `${GMAIL_BASE}/messages/${id}?${full.toString()}`, MESSAGE_MAX_BYTES)) as unknown as GmailMessage, metadataOnly: false };
    } catch (error) {
      if (!(error instanceof GoogleError) || error.kind !== 'too_large') throw error;
    }
    const meta = new URLSearchParams({ format: 'metadata' });
    for (const name of METADATA_HEADERS) meta.append('metadataHeaders', name);
    meta.set('fields', MESSAGE_FIELDS);
    return { message: assertObject(await this.getJson('message_get', `${GMAIL_BASE}/messages/${id}?${meta.toString()}`, MESSAGE_MAX_BYTES)) as unknown as GmailMessage, metadataOnly: true };
  }

  /**
   * The labels `id` carries now. The table's metadata shape with a single header (Message-ID), so the answer is small;
   * only labelIds is read. A deleted message is `not_found`.
   */
  async labelIdsOf(id: string): Promise<string[]> {
    const meta = new URLSearchParams({ format: 'metadata', metadataHeaders: 'Message-ID', fields: MESSAGE_FIELDS });
    const value = assertObject(await this.getJson('message_get', `${GMAIL_BASE}/messages/${id}?${meta.toString()}`, MESSAGE_MAX_BYTES));
    const labels = value['labelIds'];
    if (labels !== undefined && (!Array.isArray(labels) || !labels.every((item): item is string => typeof item === 'string'))) throw new GoogleError('bad_answer', 'message_get_bad_answer');
    return labels ?? [];
  }

  async labels(): Promise<GmailLabel[]> {
    const value = assertObject(await this.getJson('labels_list', `${GMAIL_BASE}/labels`));
    const labels = Array.isArray(value['labels']) ? (value['labels'] as unknown[]) : [];
    return labels.flatMap((item) => {
      const { id, name, type } = (item ?? {}) as { id?: unknown; name?: unknown; type?: unknown };
      return typeof id === 'string' && typeof name === 'string' ? [{ id, name, ...(typeof type === 'string' ? { type } : {}) }] : [];
    });
  }

  /** Creates the Gmail label `name` (under "分拣/", or "分拣" itself); answers its ID. */
  async createLabel(name: string): Promise<string> {
    const value = assertObject(await this.write('labels_create', 'POST', `${GMAIL_BASE}/labels`, { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }));
    const id = value['id'];
    if (typeof id !== 'string' || !USER_LABEL_ID.test(id)) throw new GoogleError('bad_answer', 'labels_create_bad_answer');
    return id;
  }

  /** Renames an owned label (the name stays under "分拣/"). */
  async renameLabel(labelId: string, name: string): Promise<void> {
    await this.write('labels_patch', 'PATCH', `${GMAIL_BASE}/labels/${labelId}`, { name });
  }

  /** Adds an owned label (and removes INBOX when `archive`): the ledger row must be `intended` or `applied`. */
  async classify(messageId: string, labelId: string, archive: boolean): Promise<void> {
    await this.write('message_modify', 'POST', `${GMAIL_BASE}/messages/${messageId}/modify`, archive ? { addLabelIds: [labelId], removeLabelIds: ['INBOX'] } : { addLabelIds: [labelId] });
  }

  /** Removes an owned label (and adds INBOX back when the row archived): the ledger row must be `undo_intended`. */
  async undo(messageId: string, labelId: string, archived: boolean): Promise<void> {
    await this.write('message_modify', 'POST', `${GMAIL_BASE}/messages/${messageId}/modify`, archived ? { removeLabelIds: [labelId], addLabelIds: ['INBOX'] } : { removeLabelIds: [labelId] });
  }
}
