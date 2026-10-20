/**
 * Same-origin owner transport for Todofy's planning API (`/api/plus/v1/*`). Call after owner/Origin/CSRF checks.
 * Focus is Tasks' own API; nothing else is forwarded.
 */
export async function planningRequest(request: Request, env: { PLANNING?: Fetcher }): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/plus/v1/')) return null;
  if (!env.PLANNING) {
    return Response.json(
      {
        error: {
          code: 503,
          status: 'UNAVAILABLE',
          message: 'Planning is not connected yet.',
        },
      },
      { status: 503 },
    );
  }
  // Access cookies and the owner's CSRF token terminate here; only the already-authorized request crosses.
  const headers = new Headers({ 'content-type': 'application/json' });
  return env.PLANNING.fetch(
    new Request(`https://planning.internal${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      ...(request.method === 'GET' || request.method === 'HEAD' ? {} : { body: request.body }),
      redirect: 'manual',
    }),
  );
}
