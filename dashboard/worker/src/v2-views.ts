/**
 * The Worker ↔ HomeState contract of the v2 views (docs/design-v2.md §5). The Durable Object builds
 * and serializes each view; the fetch handler only passes the string through (Workers Free: 10 ms CPU
 * per plain invocation), answering 304 when the owner's If-None-Match equals the view's ETag.
 */

/** The dynamic GET endpoints /api/v2/<view>. */
export const V2_VIEWS = ['home', 'flows', 'cloudflare', 'ops'] as const;
export type V2View = (typeof V2_VIEWS)[number];

/** Views that accept `?refresh=1` (home: statuses and probes; cloudflare: GraphQL). */
export const V2_REFRESHABLE: ReadonlySet<V2View> = new Set<V2View>(['home', 'cloudflare']);

/**
 * What HomeState.v2View returns: the strong ETag (`"<rev>"`, quotes included) and the serialized JSON
 * body, or `body: null` when `ifNoneMatch` already names this ETag (the Worker answers 304).
 */
export interface V2Body {
  readonly etag: string;
  readonly body: string | null;
}

/** An If-None-Match header names `etag` (a list, weak validators and `*` included; RFC 9110 §13.1.2). */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (ifNoneMatch === null) return false;
  const wanted = etag.replace(/^W\//, '');
  return ifNoneMatch
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === '*' || tag === wanted);
}
