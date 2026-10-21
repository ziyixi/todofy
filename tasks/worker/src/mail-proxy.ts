/**
 * Same-origin owner transport for the Mail page's reads and deletes on Todofy's Mail entry (`/api/mail/v1/*`, the
 * todofy.mail.v1 routes): the inbox list, one mail and DeleteMailSummaries. Call after the owner, Origin and CSRF
 * checks. Converting a mail and the categories are Tasks' own API; every other Mail route is unknown here.
 */
import { Code, RpcError } from '@ziyixi/proto/rpc-status';
import type { Env } from './env.ts';
import { api } from './http.ts';
import { UNKNOWN_ROUTE } from '../../shared/build.ts';

const FORWARDED: readonly { method: string; path: RegExp }[] = [
  { method: 'GET', path: /^\/api\/mail\/v1\/mailItems$/ },
  { method: 'GET', path: /^\/api\/mail\/v1\/mailItems\/[A-Za-z0-9_-]{1,100}$/ },
  { method: 'POST', path: /^\/api\/mail\/v1\/mailItems:deleteSummaries$/ },
];

export async function mailRequest(request: Request, env: Env, requestId: string): Promise<Response> {
  const url = new URL(request.url);
  if (!FORWARDED.some((route) => route.method === request.method && route.path.test(url.pathname)))
    return api.errorResponse(new RpcError(Code.NOT_FOUND, 'NOT_FOUND', UNKNOWN_ROUTE), requestId);
  if (!env.MAIL)
    return api.errorResponse(new RpcError(Code.UNAVAILABLE, 'UNAVAILABLE', 'Mail is not connected'), requestId);
  // Access cookies and the owner's CSRF token end here; only the already-authorized request crosses.
  const answer = await env.MAIL.fetch(
    new Request(`https://mail.internal${url.pathname}${url.search}`, {
      method: request.method,
      headers: { 'content-type': 'application/json' },
      ...(request.method === 'GET' ? {} : { body: request.body }),
      redirect: 'manual',
    }),
  );
  // Todofy's body (a message or a google.rpc.Status) and status; of its headers, only Retry-After.
  const headers = new Headers({ 'content-type': 'application/json' });
  const retryAfter = answer.headers.get('retry-after');
  if (retryAfter) headers.set('retry-after', retryAfter);
  return new Response(answer.body, { status: answer.status, headers });
}
