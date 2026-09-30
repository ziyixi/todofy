/** The only redirect target: a constant, so no request can choose where it is sent (no open redirect). */
export const CANONICAL_ORIGIN = "https://www.ziyixi.science";

/** What Vercel's apex 308 and the site's _headers send (no includeSubDomains: other subdomains are other apps). */
export const HSTS = "max-age=63072000";

/**
 * The request's path and query exactly as received (percent-encoding untouched, an empty `?` kept),
 * without a fragment or credentials. The runtime has already parsed and serialized request.url, so the
 * result is a valid header value.
 */
export function pathAndQuery(requestUrl: string): string {
  const url = new URL(requestUrl);
  url.hash = "";
  url.username = "";
  url.password = "";
  return url.href.slice(url.origin.length);
}

/** The 308 for any method (GET, HEAD, POST, ...): no body, a fixed host, the request's path and query. */
export function redirect(request: Request): Response {
  return new Response(null, {
    status: 308,
    headers: {
      Location: CANONICAL_ORIGIN + pathAndQuery(request.url),
      "Strict-Transport-Security": HSTS,
    },
  });
}
