/** Headers for every private (owner-only) response: never cached, never framed, no referrer. */

/** Todofy's policy, byte for byte; the default. Mail Hero passes its own (it frames sandboxed mail HTML). */
export const STRICT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
  "form-action 'self'; frame-ancestors 'none'";

/** The five private headers (lowercase names), with `csp` as the Content-Security-Policy. */
export function privateHeaders(csp: string = STRICT_CSP): Readonly<Record<string, string>> {
  return Object.freeze({
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-frame-options': 'DENY',
    'content-security-policy': csp,
  });
}

export interface PrivateHeaderOptions {
  readonly csp?: string;
  /** Replaces `no-store`, e.g. for hashed immutable assets; the app decides when. */
  readonly cacheControl?: string;
}

/**
 * A copy of the (possibly immutable) response with the private headers set, replacing any
 * existing values; status, body and other headers are kept.
 */
export function withPrivateHeaders(response: Response, options: PrivateHeaderOptions = {}): Response {
  const copy = new Response(response.body, response);
  for (const [name, value] of Object.entries(privateHeaders(options.csp))) copy.headers.set(name, value);
  if (options.cacheControl !== undefined) copy.headers.set('cache-control', options.cacheControl);
  return copy;
}
