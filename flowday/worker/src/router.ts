/**
 * The request router of the Worker "flowday". Every path needs the owner's Cloudflare Access JWT except /health and
 * the exact PWA files; every mutation also needs the CSRF token and an allowed Origin.
 *
 * Each API mutation logs one line with its D1 row counts (and answers them in x-flowday-rows-written), because the
 * account's D1 write allowance is shared with every other app.
 */
import { withPrivateHeaders } from '@ziyixi/edge-auth';
import { api } from './api.ts';
import { PWA_PUBLIC_PATHS, pwaAsset, uiAsset } from './assets.ts';
import { Meter, openDb } from './db.ts';
import { e2eEnabled, e2eRoute } from './e2e.ts';
import type { Env } from './env.ts';
import { HttpError, authenticate, checkCsrf, errorResponse, jsonResponse, methodNotAllowed, newRequestId, readBody } from './http.ts';

export const ROWS_WRITTEN_HEADER = 'x-flowday-rows-written';

function buildSha(env: Env): string {
  const value = (env.BUILD_SHA ?? '').trim();
  return /^[0-9a-f]{7,40}$|^(dev|test)$/.test(value) ? value : 'unknown';
}

async function route(request: Request, env: Env, url: URL, meter: Meter, fetcher: typeof fetch): Promise<Response> {
  const { pathname } = url;
  const read = request.method === 'GET' || request.method === 'HEAD';
  if (pathname === '/health') {
    if (!read) throw methodNotAllowed('GET, HEAD');
    return jsonResponse({ service: 'flowday', status: 'ok', build: buildSha(env) });
  }
  if (PWA_PUBLIC_PATHS.has(pathname)) {
    if (!read) throw methodNotAllowed('GET, HEAD');
    return pwaAsset(request, env.ASSETS, pathname);
  }
  const principal = await authenticate(request, env);
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    const db = openDb(env.DB, meter);
    if (pathname.startsWith('/api/test/') && e2eEnabled(env, principal)) return e2eRoute(request, env, db, pathname);
    return api({
      request,
      env,
      url,
      db,
      principal,
      fetcher,
      mutate: async () => {
        await checkCsrf(request, env, principal);
        return readBody(request);
      },
    });
  }
  if (!read) throw methodNotAllowed('GET, HEAD');
  return uiAsset(request, env.ASSETS, pathname);
}

/** The route name for logs: the path with an entry id replaced (no ids, query strings or bodies are logged). */
function routeName(pathname: string): string {
  return pathname.startsWith('/api/entries/') ? '/api/entries/:id' : pathname.startsWith('/api/') ? pathname.slice(0, 64) : 'ui';
}

export async function handleRequest(request: Request, env: Env, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  const requestId = newRequestId();
  const meter = new Meter();
  let response: Response;
  let code: string | null = null;
  try {
    response = await route(request, env, url, meter, fetcher);
  } catch (error) {
    const httpError = error instanceof HttpError ? error : new HttpError(503, 'unavailable');
    code = httpError.code;
    response = errorResponse(requestId, httpError);
  }
  if (request.body !== null && !request.body.locked) await request.body.cancel();
  // UI and PWA files carry their own private headers (page CSP, cache policy); everything else gets the defaults.
  const assetPath = !url.pathname.startsWith('/api/') && url.pathname !== '/health';
  if (assetPath && code === null) return response;
  const final = withPrivateHeaders(response);
  if (!url.pathname.startsWith('/api/')) return final;
  final.headers.set(ROWS_WRITTEN_HEADER, String(meter.rowsWritten));
  if (code !== null || request.method !== 'GET') {
    console.log(
      JSON.stringify({
        request_id: requestId,
        method: request.method,
        route: routeName(url.pathname),
        status: final.status,
        code,
        rows_written: meter.rowsWritten,
        rows_read: meter.rowsRead,
      }),
    );
  }
  return final;
}
