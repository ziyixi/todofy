/**
 * One Workers Analytics Engine data point per gateway request and per cron wake-up, for the
 * owner's SQL API queries (docs/dev-notes.md, "Metrics and ops queries"). `writeDataPoint` is
 * synchronous and needs no I/O, so the gateway stays within its CPU budget.
 *
 * Nothing identifying is written: the route is a template (`/api/v1/events/{id}`), never the
 * path, and there is no query string, owner, address or event ID.
 */
import type { Env } from './env.ts';

export type HostKind = 'owner' | 'hooks' | 'unknown' | 'cron';

export interface RequestMetric {
  readonly kind: HostKind;
  readonly method: string;
  readonly route: string;
  readonly status: number;
  /** Until the response headers: waits on the core and ASSETS, not CPU. */
  readonly wallMs: number;
  /** Declared Content-Length of the request and the response; 0 when streamed without one. */
  readonly requestBytes: number;
  readonly responseBytes: number;
}

const METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const HOOKS_ROUTES: ReadonlySet<string> = new Set(['/hooks/mail', '/api/summary', '/api/recommendation', '/health']);
const OWNER_API_ROUTES: ReadonlySet<string> = new Set([
  '/api/v1/csrf',
  '/api/v1/setup',
  '/api/v1/overview',
  '/api/v1/events',
  '/api/v1/reminders',
  '/api/v1/reports/latest',
  '/api/v1/reports/recompute',
  '/api/v1/metrics/daily',
]);
const OWNER_API_TEMPLATES: readonly (readonly [RegExp, string])[] = [
  [/^\/api\/v1\/events\/[^/]+$/, '/api/v1/events/{id}'],
  [/^\/api\/v1\/events\/[^/]+\/reconcile$/, '/api/v1/events/{id}/reconcile'],
  [/^\/api\/v1\/legacy_text\/[^/]+$/, '/api/v1/legacy_text/{id}'],
];

/** A low-cardinality route label; anything unexpected collapses into one bucket. */
export function routeOf(kind: HostKind, path: string): string {
  switch (kind) {
    case 'hooks':
      return HOOKS_ROUTES.has(path) ? path : 'other';
    case 'owner':
      if (path.startsWith('/assets/')) return 'asset';
      if (!path.startsWith('/api/')) return 'page';
      if (OWNER_API_ROUTES.has(path)) return path;
      return OWNER_API_TEMPLATES.find(([pattern]) => pattern.test(path))?.[1] ?? '/api/other';
    case 'cron':
      return 'wake';
    case 'unknown':
      return 'other';
  }
}

export function declaredBytes(headers: Headers): number {
  const length = headers.get('content-length') ?? '';
  return /^\d{1,15}$/.test(length) ? Number(length) : 0;
}

/** index: route; blobs: host kind, method, route, status class; doubles: wall ms, request and response bytes. */
export function recordRequest(env: Env, metric: RequestMetric): void {
  try {
    env.METRICS?.writeDataPoint({
      indexes: [metric.route],
      blobs: [
        metric.kind,
        METHODS.has(metric.method) ? metric.method : 'OTHER',
        metric.route,
        `${String(Math.floor(metric.status / 100))}xx`,
      ],
      doubles: [metric.wallMs, metric.requestBytes, metric.responseBytes],
    });
  } catch {
    // Metrics must never fail the request they describe.
  }
}
