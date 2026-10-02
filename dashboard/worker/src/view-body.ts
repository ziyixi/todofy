/**
 * The Worker ↔ HomeState contract of the views (docs/design-v2.md §5, proto/dashboard/ui/v1). The Durable Object
 * builds and serializes each view; the fetch handler only passes the string through (Workers Free: 10 ms CPU per
 * plain invocation), answering 304 when the owner's If-None-Match equals the view's ETag.
 */
import type { ViewId } from './api-types.ts';

/** The views HomeState builds (each a singleton of DashboardUiService). */
export const VIEW_IDS = ['home', 'flows', 'cloudflare', 'ops'] as const satisfies readonly ViewId[];

/** Each view's resource name (AIP-156 singletons: GetHomeView's `homeView`, ...), its body's first field. */
export const VIEW_NAMES: Readonly<Record<ViewId, string>> = { home: 'homeView', flows: 'flowsView', cloudflare: 'cloudflareView', ops: 'opsView' };

/** The views with a refresh (RefreshHomeView: statuses and probes; RefreshCloudflareView: GraphQL). */
export const REFRESHABLE_VIEWS: ReadonlySet<ViewId> = new Set<ViewId>(['home', 'cloudflare']);

/**
 * What HomeState.view returns: the strong ETag (`"<rev>-<hash>"`, quotes included) and the serialized JSON body, or
 * `body: null` when `ifNoneMatch` already names this ETag (the Worker answers 304).
 */
export interface ViewBody {
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
