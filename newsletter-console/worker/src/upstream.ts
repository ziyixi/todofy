/**
 * The transport of an admitted owner read to Newsletter (contracts/newsletter-ui-v1/README.md "Transport and
 * authentication"): the same path under /api/newsletter/v1/ on the platform runtime host, always as a GET, carrying
 * only the owner's assertion that edge-auth has just verified, in `cf-access-token` (the header Access reads for a
 * request that is not a browser's). The console's Access application covers that path too, so Access, the tunnel's
 * rule and Newsletter's own check all accept the same assertion; there is no service token and no stored credential.
 *
 * Newsletter writes every answer with the generated codec, so a 200 is passed through as PreEncoded without being
 * parsed (Workers Free gives a request 10 ms of CPU). Nothing upstream is trusted beyond that: a redirect is never
 * followed, the body is read under a streamed byte cap (a Content-Length through the tunnel proves nothing), and no
 * error ever copies Newsletter's body, headers or status text into the console's answer.
 */
import { PreEncoded } from '@ziyixi/proto/http-transcoder';
import { Code, RpcError } from '@ziyixi/proto/rpc-status';

/** A read that takes longer is abandoned: Newsletter answers from one short SQLite snapshot. */
export const UPSTREAM_TIMEOUT_MS = 15_000;
/** The largest answer passed on (the contract's bound for an answer through the Worker). */
export const MAX_ANSWER_BYTES = 2 * 1024 * 1024;
/** The binding prefix of newsletter.ui.v1, and where Newsletter serves it on the runtime host. */
const API_PREFIX = '/api/v1/';
const UPSTREAM_PREFIX = '/api/newsletter/v1/';
const JSON_TYPE = /^application\/json\s*(;|$)/i;

/**
 * How a forwarded read ended, for the request's log line: a status class, or why no status was used. Never a path,
 * a body or the assertion.
 */
export type UpstreamOutcome =
  | '2xx' | '3xx' | '4xx' | '5xx'
  | 'timeout' | 'network' | 'not_json' | 'too_large' | 'not_configured';

export interface Forwarded {
  /** The admitted request's URL: its path (an /api/v1/ binding the transcoder matched) and its query. */
  readonly url: URL;
  /** The owner's assertion edge-auth verified; null when the request was admitted without one (a local bypass). */
  readonly assertion: string | null;
  /** NEWSLETTER_ORIGIN as configured. */
  readonly origin: string | undefined;
  /** Receives the outcome for the log line, once. */
  readonly report?: (outcome: UpstreamOutcome) => void;
  /** Default: globalThis.fetch, looked up at call time. */
  readonly fetch?: (request: Request) => Promise<Response>;
}

function failure(code: Code, reason: string, message: string): RpcError {
  return new RpcError(code, reason, message);
}

const unavailable = (): RpcError => failure(Code.UNAVAILABLE, 'UNAVAILABLE', 'Newsletter did not answer this read.');

/** `https://<host>` exactly (no port, path, query or credentials), or null. */
export function upstreamOrigin(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const exact = url.protocol === 'https:' && url.hostname !== '' && url.port === '' && url.username === ''
    && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === '' && value === url.origin;
  return exact ? url.origin : null;
}

/**
 * The body of a 200 read into one buffer under the cap, or null when it is larger (the rest is cancelled, never read).
 * A byte stream (every fetch body in workerd) is read straight into the buffer, which halves the CPU of reading it
 * chunk by chunk (cpu.test.ts); any other stream is copied into it.
 */
async function readCapped(response: Response): Promise<Uint8Array<ArrayBuffer> | null> {
  const body = response.body as ReadableStream<Uint8Array> | null;
  if (body === null) return new Uint8Array();
  let buffer = new ArrayBuffer(MAX_ANSWER_BYTES + 1);
  let size = 0;
  let byob: ReadableStreamBYOBReader | null;
  try {
    byob = body.getReader({ mode: 'byob' });
  } catch {
    byob = null;
  }
  const reader = byob ?? body.getReader();
  for (;;) {
    if (byob !== null) {
      const { done, value } = await byob.read(new Uint8Array(buffer, size, buffer.byteLength - size));
      if (value !== undefined) {
        buffer = value.buffer;
        size += value.byteLength;
      }
      if (done) break;
    } else {
      const { done, value } = await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
      if (done) break;
      if (size + value.byteLength > buffer.byteLength) size = buffer.byteLength;
      else {
        new Uint8Array(buffer, size).set(value);
        size += value.byteLength;
      }
    }
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel();
      return null;
    }
  }
  return new Uint8Array(buffer, 0, size);
}

const failedRead = (error: unknown): UpstreamOutcome =>
  error instanceof DOMException && error.name === 'TimeoutError' ? 'timeout' : 'network';

/** Forwards one admitted read and answers Newsletter's 200 unchanged, or the console's own Status. */
export async function forward(read: Forwarded): Promise<PreEncoded> {
  let outcome: UpstreamOutcome = 'not_configured';
  try {
    return await exchange(read, (value) => { outcome = value; });
  } finally {
    read.report?.(outcome);
  }
}

async function exchange(read: Forwarded, note: (outcome: UpstreamOutcome) => void): Promise<PreEncoded> {
  const origin = upstreamOrigin(read.origin);
  if (origin === null || read.assertion === null || !read.url.pathname.startsWith(API_PREFIX)) {
    throw failure(Code.UNAVAILABLE, 'NOT_CONFIGURED', 'The console is not configured to read from Newsletter.');
  }
  const target = `${origin}${UPSTREAM_PREFIX}${read.url.pathname.slice(API_PREFIX.length)}${read.url.search}`;
  const send = read.fetch ?? ((request: Request) => globalThis.fetch(request));
  let response: Response;
  try {
    response = await send(new Request(target, {
      method: 'GET',
      headers: { accept: 'application/json', 'cf-access-token': read.assertion },
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    }));
  } catch (error) {
    note(failedRead(error));
    throw unavailable();
  }
  const status = response.status;
  note(`${String(Math.floor(status / 100))}xx` as UpstreamOutcome);
  if (status !== 200) {
    // Free the connection; the body is never read or echoed.
    await response.body?.cancel().catch(() => undefined);
    if (status === 404) throw failure(Code.NOT_FOUND, 'NOT_FOUND', 'Newsletter has no such record.');
    if (status === 400) throw failure(Code.INVALID_ARGUMENT, 'BAD_REQUEST', 'Newsletter refused this read.');
    // A redirect (Access's login page), Access refusing, a 5xx or any other status: a failed dependency.
    throw unavailable();
  }
  if (!JSON_TYPE.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel().catch(() => undefined);
    note('not_json');
    throw unavailable();
  }
  let bytes: Uint8Array<ArrayBuffer> | null;
  try {
    bytes = await readCapped(response);
  } catch (error) {
    note(failedRead(error));
    throw unavailable();
  }
  if (bytes === null) {
    note('too_large');
    throw unavailable();
  }
  try {
    // Newsletter writes UTF-8; anything else is not its answer. Decoding only checks that: the bytes read are what
    // the console answers, never encoded again (cpu.test.ts).
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    note('not_json');
    throw unavailable();
  }
  return new PreEncoded(bytes);
}
