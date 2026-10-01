/**
 * The fetch etiquette as pure functions (../../docs/design.md §4): when a watch is checked next, when a host may be
 * asked again, and how long a 429 or 503 backs off. WatchState applies them with its clock; nothing here reads one.
 *
 * Jitter is deterministic: a hash of the watch ID and the slot it is computed for, so the same inputs give the same
 * schedule (tests need no random seed) while different watches still spread over the ±10 % window.
 */
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, HOST_SPACING_MS, JITTER, MINUTE, RETRY_AFTER_MAX_MS, URL_MIN_SPACING_MS } from './limits.ts';

/** FNV-1a over the UTF-16 code units of `text`, as a fraction in [0, 1). */
export function unitHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x1_0000_0000;
}

/** A factor in [1 - JITTER, 1 + JITTER] for this watch and slot. */
export function jitterFactor(watchId: string, slot: number): number {
  return 1 - JITTER + 2 * JITTER * unitHash(`${watchId}:${String(slot)}`);
}

/**
 * The next regular check after a check at `now`: the interval moved by the watch's jitter, never sooner than
 * URL_MIN_SPACING_MS after the page's last fetch.
 */
export function nextCheckAt(watchId: string, now: number, intervalMinutes: number, lastFetchAt: number | null): number {
  const interval = intervalMinutes * MINUTE;
  const slot = Math.floor(now / interval);
  const next = now + Math.round(interval * jitterFactor(watchId, slot));
  return Math.max(next, (lastFetchAt ?? 0) + URL_MIN_SPACING_MS);
}

/** The confirmation fetch after a change found at `now`: the delay plus up to JITTER more (never less). */
export function confirmAt(watchId: string, now: number, delayMinutes: number): number {
  const delay = delayMinutes * MINUTE;
  return now + delay + Math.round(delay * JITTER * unitHash(`${watchId}:confirm:${String(now)}`));
}

/** The earliest time a page may be fetched again, given its host's state and its own last fetch. */
export function earliestFetch(now: number, host: { readonly next_at: number; readonly backoff_until: number | null } | null, lastFetchAt: number | null): number {
  return Math.max(now, host?.next_at ?? 0, host?.backoff_until ?? 0, (lastFetchAt ?? 0) + URL_MIN_SPACING_MS);
}

/** When the host may be asked again after a request that started at `start`. */
export function hostNextAt(start: number): number {
  return start + HOST_SPACING_MS;
}

/**
 * A Retry-After header value as milliseconds from `now` (delay-seconds or an HTTP-date), capped at
 * RETRY_AFTER_MAX_MS; null when absent or unreadable.
 */
export function retryAfterMs(value: string | null, now: number): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d{1,10}$/.test(text)) return Math.min(Number(text) * 1000, RETRY_AFTER_MAX_MS);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(0, date - now), RETRY_AFTER_MAX_MS);
}

/** The backoff of a 429 or 503 at `level` (0 for the first in a row) without a usable Retry-After. */
export function backoffMs(level: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, Math.min(level, 16)), BACKOFF_MAX_MS);
}

/** The next 00:00 UTC after `now`. */
export function nextUtcMidnight(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

/** The UTC day of `now`, `YYYY-MM-DD`. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
