/** Owner HTTP surface: authenticate first, then the shared, read-only IDL transcoder. */
import { createAccessVerifier, withPrivateHeaders, STRICT_CSP } from '@ziyixi/edge-auth';
import { FleetUiService, SummarizeNodeMetricsRequest_Range as Range } from '@ziyixi/proto/fleet/ui/v1/fleet_ui_service_pb';
import { timestampMs } from '@ziyixi/proto/protobuf/wkt';
import { HttpTranscoder, PreEncoded } from '@ziyixi/proto/http-transcoder';
import { RpcError, Code } from '@ziyixi/proto/rpc-status';
import type { Env } from './env.ts';
import { METRICS, type RangeName } from './metrics.ts';
import { handleReceipt } from './receipt.ts';
import { REPORT_PATH } from './report.ts';
import { OBJECT_NAME, type FleetState } from './state.ts';

interface OwnerContext { readonly env: Env; readonly at: number; }
const verifier = createAccessVerifier();
function error(code: Code, reason: string): RpcError {
  return new RpcError(code, reason, 'Fleet request failed.');
}

const RANGES: Readonly<Record<number, RangeName>> = {
  [Range.UNSPECIFIED]: 'day', [Range.DAY]: 'day', [Range.WEEK]: 'week', [Range.MONTH]: 'month',
  [Range.HALF_YEAR]: 'half_year', [Range.TWO_YEARS]: 'two_years',
};
/** The earliest range end a summary reads; older ones are refused rather than written as odd timestamps. */
const EARLIEST_END = Date.UTC(2020, 0, 1);

function nodeKey(name: string): string {
  const match = /^nodes\/([a-z][a-z0-9_-]{0,31})$/.exec(name);
  if (!match?.[1]) throw error(Code.INVALID_ARGUMENT, 'BAD_REQUEST');
  return match[1];
}

/** Every Durable Object call is the one dependency: its failure is UNAVAILABLE, its null answer NOT_FOUND. */
async function fromState(context: OwnerContext, call: (stub: DurableObjectStub<FleetState>) => Promise<string | null>): Promise<PreEncoded> {
  let text: string | null;
  try {
    text = await call(context.env.FLEET.get(context.env.FLEET.idFromName(OBJECT_NAME)));
  } catch {
    throw error(Code.UNAVAILABLE, 'UNAVAILABLE');
  }
  if (text === null) throw error(Code.NOT_FOUND, 'NOT_FOUND');
  return new PreEncoded(text);
}

const api = new HttpTranscoder<typeof FleetUiService.method, OwnerContext>(FleetUiService, {
  getFleetStatus: (_request, context) => fromState(context, (stub) => stub.view(context.at)),
  getNode: (request, context) => {
    const node = nodeKey(request.name);
    return fromState(context, (stub) => stub.node(node));
  },
  listNodes: (request, context) => {
    if (request.pageSize < 0 || request.pageToken !== '') throw error(Code.INVALID_ARGUMENT, 'BAD_REQUEST');
    return fromState(context, (stub) => stub.nodes());
  },
  summarizeNodeMetrics: (request, context) => {
    const node = nodeKey(request.name);
    const range = RANGES[request.range];
    const end = Math.min(request.endTime ? timestampMs(request.endTime) : context.at, context.at);
    if (!range || end < EARLIEST_END || request.metrics.length > 32
      || request.metrics.some((metric) => !Object.hasOwn(METRICS, metric))) {
      throw error(Code.INVALID_ARGUMENT, 'BAD_REQUEST');
    }
    return fromState(context, (stub) => stub.summarize(node, range, end, request.metrics));
  },
}, {
  domain: 'fleet.ziyixi.science',
  maxBodyBytes: 1024,
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

/** Only a verified local bypass may select the synthetic test clock. */
function requestTime(env: Env, local: boolean): number {
  if (local && env.DEV_NOW) return Date.parse(env.DEV_NOW);
  return Date.now();
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const local = localRequest(request, env, url);
  if (!local && (url.protocol !== 'https:' || url.host !== env.PUBLIC_HOST)) {
    return new Response('Not found', { status: 404 });
  }
  const at = requestTime(env, local);
  if (url.pathname === REPORT_PATH) {
    return withPrivateHeaders(await handleReceipt(request, env, at));
  }
  const auth = await verifier.verify(request, {
    issuer: env.ACCESS_ISSUER,
    audience: env.ACCESS_AUDIENCE,
    owner: env.ACCESS_OWNER,
    aliases: env.ACCESS_OWNER_ALIASES,
    emailMatch: 'case-insensitive',
    nbfLeewaySeconds: 60,
    tokenSource: { emptyHeader: 'use-cookie', cookie: 'last' },
    devBypass: {
      enabled: env.DEV_AUTH_BYPASS === 'true',
      hosts: 'loopback-http',
      principal: env.ACCESS_OWNER ?? '',
      whenNotLocal: 'refuse',
    },
  });
  if (!auth.ok) {
    const unavailable = auth.failure === 'keys_unavailable' || auth.failure === 'not_configured';
    return withPrivateHeaders(api.errorResponse(
      error(unavailable ? Code.UNAVAILABLE : Code.UNAUTHENTICATED, unavailable ? 'UNAVAILABLE' : 'UNAUTHORIZED'),
      'fleet-request', request.method === 'HEAD',
    ));
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return withPrivateHeaders(new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } }));
  }
  const result = await api.handle(request, { env, at }, 'fleet-request');
  if (result) return withPrivateHeaders(result.response);
  if (url.pathname.startsWith('/api/')) {
    return withPrivateHeaders(new Response('Not found', { status: 404 }));
  }
  return withPrivateHeaders(await env.ASSETS.fetch(request), { csp: STRICT_CSP });
}
