/**
 * Cloudflare Email Routing ingress. The R2 object is the durable handoff point;
 * every network delivery after that point is replayable with the same ID.
 */

const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;
const BATCH_SIZE = 8;
const INITIAL_DELIVERY_GRACE_MS = 60_000;
const HTTP_TIMEOUT_MS = 20_000;
const MAX_RETRY_AFTER_MS = 24 * 60 * 60_000;
const CONTROL_PAUSED = "_control/paused.json";
const CONTROL_CURSOR = "_control/cursor.json";

// Cloudflare-specific global. R2 requires a stream with a known byte length;
// EmailMessage.raw is a plain ReadableStream even though rawSize is available.
declare class FixedLengthStream {
  constructor(length: number);
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
}

export interface EmailMessage {
  readonly from: string;
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

interface BufferObject {
  key: string;
  size: number;
  uploaded: Date;
  customMetadata?: Record<string, string>;
}

interface BufferObjectBody extends BufferObject {
  body: ReadableStream<Uint8Array>;
}

export interface BufferBucket {
  put(key: string, value: ReadableStream<Uint8Array> | string, options?: {
    customMetadata?: Record<string, string>;
  }): Promise<BufferObject | null>;
  get(key: string): Promise<BufferObjectBody | null>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; limit: number; cursor?: string; include?: string[] }): Promise<{
    objects: BufferObject[];
    truncated: boolean;
    cursor?: string;
  }>;
}

export interface Env {
  MAIL_BUFFER: BufferBucket;
  RECEIVE_ADDRESS: string;
  INGEST_URL: string;
  INGEST_TOKEN: string;
  STATUS_TOKEN?: string;
  CF_ACCESS_CLIENT_ID?: string;
  CF_ACCESS_CLIENT_SECRET?: string;
}

interface Context {
  waitUntil(promise: Promise<unknown>): void;
}

type State = {
  kind: "retry" | "quarantined";
  attempts: number;
  next_attempt_at: string | null;
  last_error_code: string;
  http_status: number | null;
  updated_at: string;
};

type Pause = { reason: string; since: string };

type Metadata = {
  ingest_id: string;
  from: string;
  to: string;
  received_at: string;
  raw_size: string;
};

function rawKey(id: string): string { return `pending/${id}.eml`; }
function stateKey(id: string): string { return `state/${id}.json`; }
function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function idFromKey(key: string): string | null {
  const match = /^pending\/([0-9a-f-]{36})\.eml$/.exec(key);
  return match && isUUID(match[1]) ? match[1] : null;
}

function exactRecipient(actual: string, configured: string): boolean {
  const a = actual.lastIndexOf("@");
  const b = configured.lastIndexOf("@");
  return a > 0 && b > 0 && actual.slice(0, a) === configured.slice(0, b) &&
    actual.slice(a + 1).toLowerCase() === configured.slice(b + 1).toLowerCase();
}

function configured(env: Env): void {
  if (!env.RECEIVE_ADDRESS || !env.INGEST_TOKEN || !env.INGEST_URL) {
    throw new Error("missing_ingress_configuration");
  }
  const url = new URL(env.INGEST_URL);
  if (url.protocol !== "https:" || url.pathname !== "/api/v1/ingest/email" || url.search || url.hash) {
    throw new Error("invalid_ingest_url");
  }
  if (Boolean(env.CF_ACCESS_CLIENT_ID) !== Boolean(env.CF_ACCESS_CLIENT_SECRET)) {
    throw new Error("incomplete_access_service_token");
  }
}

function metadataOf(object: BufferObject): Metadata | null {
  const m = object.customMetadata;
  if (!m || !isUUID(m.ingest_id) || object.key !== rawKey(m.ingest_id) ||
      typeof m.from !== "string" || !m.to || m.from.length > 512 || m.to.length > 512 ||
      !Number.isFinite(Date.parse(m.received_at)) || !/^\d+$/.test(m.raw_size) ||
      Number(m.raw_size) !== object.size || object.size > MAX_MESSAGE_BYTES) {
    return null;
  }
  return { ingest_id: m.ingest_id, from: m.from, to: m.to,
    received_at: m.received_at, raw_size: m.raw_size };
}

function encodeMetadata(metadata: Metadata): string {
  const bytes = new TextEncoder().encode(JSON.stringify({
    from: metadata.from, to: metadata.to, received_at: metadata.received_at,
    size_bytes: Number(metadata.raw_size),
  }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function parseJson<T>(body: BufferObjectBody): Promise<T> {
  return new Response(body.body).json() as Promise<T>;
}

async function getJson<T>(bucket: BufferBucket, key: string): Promise<T | null> {
  const object = await bucket.get(key);
  return object ? parseJson<T>(object) : null;
}

async function getState(bucket: BufferBucket, id: string): Promise<State | null> {
  const object = await bucket.get(stateKey(id));
  if (!object) return null;
  try {
    const state = await parseJson<State>(object);
    if ((state.kind === "retry" || state.kind === "quarantined") &&
        Number.isInteger(state.attempts) && state.attempts >= 0 &&
        (state.next_attempt_at === null || Number.isFinite(Date.parse(state.next_attempt_at)))) {
      return state;
    }
  } catch { /* A malformed state must not trigger a blind resend. */ }
  await saveState(bucket, id, {
    kind: "quarantined", attempts: 0, next_attempt_at: null,
    last_error_code: "invalid_state", http_status: null, updated_at: new Date().toISOString(),
  });
  return { kind: "quarantined", attempts: 0, next_attempt_at: null,
    last_error_code: "invalid_state", http_status: null, updated_at: new Date().toISOString() };
}

async function saveState(bucket: BufferBucket, id: string, state: State): Promise<void> {
  if (!await bucket.put(stateKey(id), JSON.stringify(state))) throw new Error("state_write_failed");
}

async function pause(bucket: BufferBucket, reason: string, now: number): Promise<void> {
  if (!await bucket.put(CONTROL_PAUSED, JSON.stringify({ reason, since: new Date(now).toISOString() }))) {
    throw new Error("pause_write_failed");
  }
}

async function isPaused(bucket: BufferBucket): Promise<Pause | null> {
  return getJson<Pause>(bucket, CONTROL_PAUSED);
}

export function retryAfterMillis(value: string | null, now: number): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) {
    const seconds = Number(value.trim());
    return Number.isSafeInteger(seconds) ? seconds * 1000 : null;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function backoffMillis(attempts: number, jitter = Math.random()): number {
  const capped = Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 10));
  return Math.floor(capped * (0.75 + jitter * 0.5));
}

async function retry(bucket: BufferBucket, id: string, attempts: number, now: number,
  code: string, status: number | null, retryAfter: number | null): Promise<void> {
  if (retryAfter !== null && retryAfter > MAX_RETRY_AFTER_MS) {
    await saveState(bucket, id, {
      kind: "retry", attempts, next_attempt_at: new Date(now + MAX_RETRY_AFTER_MS).toISOString(),
      last_error_code: code, http_status: status, updated_at: new Date(now).toISOString(),
    });
    await pause(bucket, "retry_after_too_long", now);
    return;
  }
  const delay = Math.max(backoffMillis(attempts), retryAfter ?? 0);
  await saveState(bucket, id, {
    kind: "retry", attempts, next_attempt_at: new Date(now + delay).toISOString(),
    last_error_code: code, http_status: status, updated_at: new Date(now).toISOString(),
  });
}

async function quarantine(bucket: BufferBucket, id: string, attempts: number, now: number,
  code: string, status: number | null): Promise<void> {
  await saveState(bucket, id, {
    kind: "quarantined", attempts, next_attempt_at: null,
    last_error_code: code, http_status: status, updated_at: new Date(now).toISOString(),
  });
}

export async function deliverOne(env: Env, id: string, now = Date.now()): Promise<"delivered" | "retry" | "quarantined" | "paused" | "missing" | "not_due"> {
  configured(env);
  if (await isPaused(env.MAIL_BUFFER)) return "paused";
  const state = await getState(env.MAIL_BUFFER, id);
  if (state?.kind === "quarantined") return "quarantined";
  if (state?.next_attempt_at && Date.parse(state.next_attempt_at) > now) return "not_due";
  const object = await env.MAIL_BUFFER.get(rawKey(id));
  if (!object) return "missing";
  const metadata = metadataOf(object);
  if (!metadata) {
    await quarantine(env.MAIL_BUFFER, id, state?.attempts ?? 0, now, "invalid_metadata", null);
    return "quarantined";
  }

  const headers = new Headers({
    "Content-Type": "message/rfc822",
    "Authorization": `Bearer ${env.INGEST_TOKEN}`,
    "X-Mail-Hero-Ingest-Id": id,
    "X-Mail-Hero-Metadata": encodeMetadata(metadata),
  });
  if (env.CF_ACCESS_CLIENT_ID && env.CF_ACCESS_CLIENT_SECRET) {
    headers.set("CF-Access-Client-Id", env.CF_ACCESS_CLIENT_ID);
    headers.set("CF-Access-Client-Secret", env.CF_ACCESS_CLIENT_SECRET);
  }
  const attempts = (state?.attempts ?? 0) + 1;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(env.INGEST_URL, {
      method: "POST", headers, body: object.body,
      redirect: "manual", signal: controller.signal, duplex: "half",
    } as RequestInit & { duplex: "half" });
  } catch {
    await retry(env.MAIL_BUFFER, id, attempts, now, "network_error", null, null);
    return "retry";
  } finally {
    clearTimeout(timeout);
  }
  response.body?.cancel().catch(() => {});

  if (response.status === 204 && response.headers.get("X-Mail-Hero-Ingest-Id") === id) {
    // A lost delete only causes a replay; Mail Hero deduplicates the stable ID.
    await env.MAIL_BUFFER.delete(rawKey(id));
    await env.MAIL_BUFFER.delete(stateKey(id));
    return "delivered";
  }
  if (response.status === 401 || response.status === 403 ||
      (response.status >= 300 && response.status < 400) ||
      (response.status >= 200 && response.status < 300)) {
    await pause(env.MAIL_BUFFER, response.status === 401 || response.status === 403
      ? "authentication_failed" : "ingest_contract_failed", now);
    return "paused";
  }
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    await retry(env.MAIL_BUFFER, id, attempts, now, `http_${response.status}`, response.status,
      retryAfterMillis(response.headers.get("Retry-After"), now));
    return "retry";
  }
  await quarantine(env.MAIL_BUFFER, id, attempts, now, `http_${response.status}`, response.status);
  return "quarantined";
}

export async function emailHandler(message: EmailMessage, env: Env, ctx: Context): Promise<void> {
  configured(env);
  if (!exactRecipient(message.to, env.RECEIVE_ADDRESS)) {
    message.setReject("Unknown recipient");
    return;
  }
  if (!Number.isSafeInteger(message.rawSize) || message.rawSize < 0 ||
      message.rawSize > MAX_MESSAGE_BYTES) {
    message.setReject("Message too large");
    return;
  }
  if (message.from.length > 512 || message.to.length > 512 ||
      /[\r\n]/.test(message.from + message.to)) {
    message.setReject("Invalid envelope");
    return;
  }
  const id = crypto.randomUUID();
  const metadata: Metadata = {
    ingest_id: id, from: message.from, to: message.to,
    received_at: new Date().toISOString(), raw_size: String(message.rawSize),
  };
  // Awaiting this R2 commit is the critical path. FixedLengthStream preserves
  // streaming without buffering a 25 MiB message and detects a short/long raw.
  const fixed = new FixedLengthStream(message.rawSize);
  const pumping = message.raw.pipeTo(fixed.writable);
  let written: BufferObject | null;
  try {
    [written] = await Promise.all([
      env.MAIL_BUFFER.put(rawKey(id), fixed.readable, { customMetadata: { ...metadata } }),
      pumping,
    ]);
  } catch (error) {
    await fixed.readable.cancel().catch(() => {});
    await pumping.catch(() => {});
    throw error;
  }
  if (!written || written.size !== message.rawSize) {
    if (written) await env.MAIL_BUFFER.delete(rawKey(id));
    throw new Error("raw_archive_failed");
  }
  // Opportunistic fast delivery. Cron owns recovery if this invocation ends.
  ctx.waitUntil(deliverOne(env, id).catch(() => {
    console.error("initial_delivery_failed", id);
  }));
}

async function readCursor(bucket: BufferBucket): Promise<string | undefined> {
  try {
    const value = await getJson<{ cursor?: string }>(bucket, CONTROL_CURSOR);
    return typeof value?.cursor === "string" && value.cursor.length < 4096 ? value.cursor : undefined;
  } catch {
    await bucket.delete(CONTROL_CURSOR);
    return undefined;
  }
}

export async function runScheduled(env: Env, now = Date.now()): Promise<void> {
  configured(env);
  if (await isPaused(env.MAIL_BUFFER)) return;
  const cursor = await readCursor(env.MAIL_BUFFER);
  let page;
  try {
    page = await env.MAIL_BUFFER.list({ prefix: "pending/", limit: BATCH_SIZE, cursor });
  } catch (error) {
    if (!cursor) throw error;
    // An invalid/expired cursor is reset; the next run starts at the beginning.
    await env.MAIL_BUFFER.delete(CONTROL_CURSOR);
    return;
  }
  for (const object of page.objects) {
    const id = idFromKey(object.key);
    if (!id) continue;
    if (now - object.uploaded.getTime() < INITIAL_DELIVERY_GRACE_MS) continue;
    try {
      const outcome = await deliverOne(env, id, now);
      if (outcome === "paused") return;
    } catch {
      // The raw object remains in R2, so a later sweep can try again.
      console.error("scheduled_delivery_failed", id);
    }
  }
  if (page.truncated && page.cursor) {
    if (!await env.MAIL_BUFFER.put(CONTROL_CURSOR, JSON.stringify({ cursor: page.cursor }))) {
      throw new Error("cursor_write_failed");
    }
  } else {
    await env.MAIL_BUFFER.delete(CONTROL_CURSOR);
  }
}

function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided?.startsWith("Bearer ")) return false;
  const actual = provided.slice(7);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function fetchHandler(request: Request, env: Env, now = Date.now()): Promise<Response> {
  const url = new URL(request.url);
  if (!env.STATUS_TOKEN || !tokenMatches(request.headers.get("Authorization"), env.STATUS_TOKEN)) {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  if (url.pathname === "/resume" && request.method === "POST") {
    await env.MAIL_BUFFER.delete(CONTROL_PAUSED);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  }
  if (url.pathname !== "/status" || request.method !== "GET") {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const paused = await isPaused(env.MAIL_BUFFER);
  const page = await env.MAIL_BUFFER.list({ prefix: "pending/", limit: 20, include: ["customMetadata"] });
  let due = 0, retryWait = 0, quarantined = 0;
  let oldest: string | null = null;
  for (const object of page.objects) {
    const id = idFromKey(object.key);
    if (!id) continue;
    const state = await getState(env.MAIL_BUFFER, id);
    if (state?.kind === "quarantined") quarantined++;
    else if (state?.next_attempt_at && Date.parse(state.next_attempt_at) > now) retryWait++;
    else due++;
    const received = object.customMetadata?.received_at;
    if (received && Number.isFinite(Date.parse(received)) && (!oldest || received < oldest)) oldest = received;
  }
  return Response.json({
    paused: Boolean(paused), pause_reason: paused?.reason ?? null,
    scanned: page.objects.length, due, retry_wait: retryWait, quarantined,
    oldest_received_at: oldest, truncated: page.truncated,
  }, { headers: { "Cache-Control": "no-store" } });
}

export default {
  email: emailHandler,
  scheduled: (_controller: unknown, env: Env, ctx: Context): void => {
    ctx.waitUntil(runScheduled(env));
  },
  fetch: fetchHandler,
};
