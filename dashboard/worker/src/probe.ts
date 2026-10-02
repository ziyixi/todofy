/**
 * The `public_http` status source (docs/design-v2.md §3): one GET from HomeState to a public, not
 * Access-protected URL of the registry, at most once per tick (and per PROBE_MIN_INTERVAL_SECONDS for
 * owner refreshes). Only the status code, the media type of the Content-Type header and the latency are
 * looked at: `redirect: 'manual'` (a redirect is an answer, never followed), no credentials or cookies,
 * and the body is cancelled unread.
 */
import { PROBE_MIN_INTERVAL_SECONDS, PROBE_TIMEOUT_MS } from './api-v2-types.ts';
import type { ProbeDoc } from './docs.ts';
import type { FetchLike } from './usage.ts';

/** What one probe asks for: the registry's `public_http` fields. */
export interface ProbeTarget {
  readonly url: string;
  readonly expect: readonly number[];
  /** Lowercase media type without parameters; absent: any (or no) Content-Type passes. */
  readonly content_type?: string;
}

export interface ProbeResult {
  readonly ok: boolean;
  readonly http_status: number | null;
  readonly latency_ms: number | null;
  readonly error: ProbeDoc['error'];
}

/** One probe; never throws. `clock` is Date.now (it advances across I/O in workerd). */
export async function probeUrl(
  target: ProbeTarget,
  fetcher: FetchLike = (url, init) => globalThis.fetch(url, init),
  clock: () => number = Date.now,
): Promise<ProbeResult> {
  const started = clock();
  let response: Response;
  try {
    response = await fetcher(target.url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: target.content_type ?? 'application/json' },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { ok: false, http_status: null, latency_ms: null, error: timedOut ? 'timeout' : 'network_error' };
  }
  const latency = Math.max(0, Math.round(clock() - started));
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to read either way.
  }
  let error: ProbeResult['error'] = null;
  if (!target.expect.includes(response.status)) error = 'http_status';
  else if (target.content_type !== undefined && mediaType(response.headers.get('content-type')) !== target.content_type) error = 'content_type';
  return { ok: error === null, http_status: response.status, latency_ms: latency, error };
}

/** `Text/Plain; charset=utf-8` → `text/plain`; no header → null. */
export function mediaType(header: string | null): string | null {
  if (header === null) return null;
  return (header.split(';')[0] ?? '').trim().toLowerCase();
}

/** The stored document after `result` at `now`. */
export function nextProbeDoc(previous: ProbeDoc | null, result: ProbeResult, now: number): ProbeDoc {
  return {
    checked_at: now,
    ok: result.ok,
    http_status: result.http_status,
    latency_ms: result.latency_ms,
    error: result.error,
    consecutive_failures: result.ok ? 0 : (previous?.consecutive_failures ?? 0) + 1,
  };
}

/** Whether a probe may run at `now`: never ran, or the last one is PROBE_MIN_INTERVAL_SECONDS old (or from a later clock). */
export function probeDue(previous: ProbeDoc | null, now: number): boolean {
  return previous === null || now - previous.checked_at >= PROBE_MIN_INTERVAL_SECONDS * 1000 || now < previous.checked_at;
}
