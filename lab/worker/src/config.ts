/**
 * Vars of the Worker "lab" (../wrangler.toml, docs/design.md §3), parsed fail-safe: an invalid neuron
 * ceiling reads as 0 (no AI call at all), an invalid fetch hour as the committed default.
 */
import type { Env } from './env.ts';

/** The account-wide Workers AI allowance per UTC day; the Lab ceiling can never exceed it. */
export const ACCOUNT_DAILY_NEURONS = 10_000;
export const DEFAULT_FETCH_UTC_HOUR = 6;

/** LAB_DAILY_NEURONS as an integer in 0..10,000; anything else is 0, which stops every AI call. */
export function neuronCeiling(env: Pick<Env, 'LAB_DAILY_NEURONS'>): number {
  const raw = (env.LAB_DAILY_NEURONS as string | undefined)?.trim() ?? '';
  if (!/^[0-9]{1,5}$/.test(raw)) return 0;
  const value = Number(raw);
  return value <= ACCOUNT_DAILY_NEURONS ? value : 0;
}

export function fetchHour(env: Pick<Env, 'LAB_FETCH_UTC_HOUR'>): number {
  const raw = (env.LAB_FETCH_UTC_HOUR as string | undefined)?.trim() ?? '';
  if (!/^[0-9]{1,2}$/.test(raw)) return DEFAULT_FETCH_UTC_HOUR;
  const value = Number(raw);
  return value <= 23 ? value : DEFAULT_FETCH_UTC_HOUR;
}

/** The lowercase public host, or null when it is not a plain host name. */
export function publicHost(env: Pick<Env, 'PUBLIC_HOST'>): string | null {
  const host = ((env.PUBLIC_HOST as string | undefined) ?? '').trim().toLowerCase();
  return /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ? host : null;
}

export function buildSha(env: Pick<Env, 'BUILD_SHA'>): string {
  const sha = (env.BUILD_SHA ?? '').trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(sha) ? sha : 'unknown';
}

// ---- time ---------------------------------------------------------------------------------------------

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** RFC 3339 UTC without milliseconds, e.g. 2026-09-30T06:30:00Z. */
export function iso(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

/** The UTC calendar day of `ms`, `YYYY-MM-DD`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` plus `days` (may be negative). */
export function addDays(day: string, days: number): string {
  return utcDay(Date.parse(`${day}T00:00:00Z`) + days * DAY);
}

/** The first daily fetch slot (`hour`:30 UTC) strictly after `now`. */
export function nextFetchSlot(now: number, hour: number): number {
  const today = Date.parse(`${utcDay(now)}T00:00:00Z`) + hour * HOUR + 30 * MINUTE;
  return today > now ? today : today + DAY;
}

export const DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

export function isDay(value: unknown): value is string {
  return typeof value === 'string' && DAY_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && utcDay(Date.parse(`${value}T00:00:00Z`)) === value;
}
