/** UTC calendar helpers. Every decision function takes `now` (epoch milliseconds) explicitly. */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` of the UTC day containing `ms`. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** `YYYY-MM-01` of the UTC month containing `ms`. */
export function utcMonthStart(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 7)}-01`;
}

/** 00:00 UTC of the day containing `ms`. */
export function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** 00:00 UTC of the day after the one containing `ms`. */
export function nextUtcMidnight(ms: number): number {
  return startOfUtcDay(ms) + DAY_MS;
}

/** 00:00 UTC on the 1st of the month containing `ms`. */
export function startOfUtcMonth(ms: number): number {
  const date = new Date(ms);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

export function daysInUtcMonth(ms: number): number {
  const date = new Date(ms);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
}

/** RFC 3339 UTC with milliseconds (`2026-09-29T16:00:00.000Z`). */
export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function isoOrNull(ms: number | null | undefined): string | null {
  return ms === null || ms === undefined ? null : iso(ms);
}

/** RFC 3339 UTC with seconds precision (`2026-09-29T16:00:00Z`), as the GraphQL `Time` variables. */
export function isoSeconds(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/;

/** An ops-v1 `Timestamp` parsed to epoch milliseconds; null for anything else. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function isTimestamp(value: unknown): value is string {
  return parseTimestamp(value) !== null;
}

/** One decimal place (percentages, projections). */
export function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
