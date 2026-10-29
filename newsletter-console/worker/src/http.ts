/**
 * Owner HTTP surface: authenticate first, admit reads only, then the shared IDL transcoder of newsletter.ui.v1, whose
 * every method forwards the read to Newsletter (upstream.ts).
 *
 * Newsletter's SQLite database is the record and Newsletter answers every method itself; this Worker only transports
 * the owner's reads to it (contracts/newsletter-ui-v1/README.md) and holds no data and no credential of its own.
 */
import {
  ACCESS_TOKEN_COOKIE,
  ACCESS_TOKEN_HEADER,
  createAccessVerifier,
  readCookie,
  STRICT_CSP,
  withPrivateHeaders,
  type AccessPolicy,
} from '@ziyixi/edge-auth';
import { NewsletterUiService } from '@ziyixi/proto/newsletter/ui/v1/newsletter_ui_service_pb';
import { HttpTranscoder, type PreEncoded } from '@ziyixi/proto/http-transcoder';
import { RpcError, Code } from '@ziyixi/proto/rpc-status';
import type { Env } from './env.ts';
import { forward, type UpstreamOutcome } from './upstream.ts';

interface OwnerContext {
  readonly env: Env;
  readonly url: URL;
  /** The owner's assertion edge-auth verified, the only credential sent upstream; null under the local bypass. */
  readonly assertion: string | null;
  /** How the forwarded read ended, for the log line. */
  outcome: UpstreamOutcome | null;
}
const verifier = createAccessVerifier();
/** Hashed build output under /assets/ never changes, so the browser may keep it; everything else is no-store. */
const IMMUTABLE = 'private, max-age=31536000, immutable';
/**
 * Where edge-auth reads the login from. ownerAssertion() reads it by the same rule, so the token forwarded is the one
 * that was verified.
 */
const TOKEN_SOURCE: AccessPolicy['tokenSource'] = { emptyHeader: 'use-cookie', cookie: 'last' };
function error(code: Code, reason: string): RpcError {
  return new RpcError(code, reason, 'Newsletter console request failed.');
}

/** The assertion edge-auth verifies under TOKEN_SOURCE: the header unless it is empty, else the last Access cookie. */
export function ownerAssertion(request: Request): string | null {
  const header = request.headers.get(ACCESS_TOKEN_HEADER);
  const token = header !== null && header !== '' ? header : readCookie(request, ACCESS_TOKEN_COOKIE, TOKEN_SOURCE.cookie);
  return token === null || token === '' ? null : token;
}

/** Every method is a read Newsletter answers: the transcoder has matched and strictly decoded it before this runs. */
function read(_request: unknown, context: OwnerContext): Promise<PreEncoded> {
  return forward({
    url: context.url,
    assertion: context.assertion,
    origin: context.env.NEWSLETTER_ORIGIN,
    report: (outcome) => { context.outcome = outcome; },
  });
}

const api = new HttpTranscoder<typeof NewsletterUiService.method, OwnerContext>(NewsletterUiService, {
  getOverview: read,
  listRuns: read,
  getRun: read,
  listModelCalls: read,
  summarizeModelUsage: read,
  listEditions: read,
  getEdition: read,
  getEditionRendering: read,
  getSourceCatalog: read,
  getBackupStatus: read,
}, {
  domain: 'news.ziyixi.science',
  // Every method is a GET with its input in the path and query: no request body is ever read.
  maxBodyBytes: 0,
  authorize: (_request, route) => {
    // There are no owner mutations. A future mutation must add Origin and CSRF validation here first.
    if (!route.safe) throw error(Code.PERMISSION_DENIED, 'READ_ONLY');
    return Promise.resolve();
  },
});

function localRequest(request: Request, env: Env, url: URL): boolean {
  return env.DEV_AUTH_BYPASS === 'true'
    && url.protocol === 'http:'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && !request.headers.has('cf-ray');
}

/**
 * One line per API request: its ID, method name, status class, how the read to Newsletter ended (a status class or a
 * code) and duration; never a path value, query, body or token.
 */
function logRequest(id: string, rpc: string | undefined, status: number, upstream: UpstreamOutcome | null, started: number): void {
  console.log(JSON.stringify({
    event: 'newsletter_console_request', request_id: id, rpc: rpc ?? null,
    status_class: `${String(Math.floor(status / 100))}xx`, upstream, ms: Date.now() - started,
  }));
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const local = localRequest(request, env, url);
  if (!local && (url.protocol !== 'https:' || url.host !== env.PUBLIC_HOST)) {
    return new Response('Not found', { status: 404 });
  }
  const started = Date.now();
  const id = crypto.randomUUID();
  const auth = await verifier.verify(request, {
    issuer: env.ACCESS_ISSUER,
    audience: env.ACCESS_AUDIENCE,
    owner: env.ACCESS_OWNER,
    aliases: env.ACCESS_OWNER_ALIASES,
    emailMatch: 'case-insensitive',
    nbfLeewaySeconds: 60,
    tokenSource: TOKEN_SOURCE,
    devBypass: {
      enabled: env.DEV_AUTH_BYPASS === 'true',
      hosts: 'loopback-http',
      principal: env.ACCESS_OWNER ?? '',
      whenNotLocal: 'refuse',
    },
  });
  if (!auth.ok) {
    const unavailable = auth.failure === 'keys_unavailable' || auth.failure === 'not_configured' || auth.failure === 'dev_bypass_refused';
    return withPrivateHeaders(api.errorResponse(
      error(unavailable ? Code.UNAVAILABLE : Code.UNAUTHENTICATED, unavailable ? 'UNAVAILABLE' : 'UNAUTHORIZED'),
      id, request.method === 'HEAD',
    ));
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // The contract's METHOD_NOT_ALLOWED, as a Status body like every other answer (mailsort's and recall's shape).
    const notAllowed = new RpcError(Code.UNIMPLEMENTED, 'METHOD_NOT_ALLOWED', 'this method is not allowed on this path',
      { httpStatus: 405, headers: { allow: 'GET, HEAD' } });
    return withPrivateHeaders(api.errorResponse(notAllowed, id, false));
  }
  const context: OwnerContext = { env, url, assertion: auth.bypassed ? null : ownerAssertion(request), outcome: null };
  const result = await api.handle(request, context, id);
  if (result) {
    logRequest(id, result.route?.method.name, result.response.status, context.outcome, started);
    return withPrivateHeaders(result.response);
  }
  if (url.pathname.startsWith('/api/')) {
    return withPrivateHeaders(new Response('Not found', { status: 404 }));
  }
  const asset = await env.ASSETS.fetch(request);
  // Only a 200 that is not the single-page fallback (index.html) may be cached.
  const cacheable = url.pathname.startsWith('/assets/') && asset.status === 200
    && !(asset.headers.get('content-type') ?? '').toLowerCase().startsWith('text/html');
  return withPrivateHeaders(asset, cacheable ? { csp: STRICT_CSP, cacheControl: IMMUTABLE } : { csp: STRICT_CSP });
}
