/**
 * The schedule (../../docs/design.md §2), in America/Los_Angeles, computed for each day from Intl.DateTimeFormat's
 * offsets. No slot falls between 01:00 and 03:00, so none is skipped or repeated at a DST change.
 *
 * | Time | Monday-Friday | Saturday | Sunday |
 * | --- | --- | --- | --- |
 * | 12:30, 18:30, 23:30 | fetch rounds | fetch rounds | fetch rounds |
 * | 03:30 | the cutoff round, then the weekday issue | the cutoff round, then the deep read | — |
 * | 06:30 / 07:30 | the send (until 12:00) | the send (until 12:00) | — |
 * | 12:00 | | | the weekly learning |
 *
 * A round's key is its local date and time (`2026-10-12T03:30`); the issue's date is the local date of its cutoff.
 * Pure functions.
 */
import { CUTOFF_ROUND, FETCH_ROUNDS, LATE_TIME, LEARN_TIME, SEND_CUTOFF, SEND_SATURDAY, SEND_WEEKDAY, TIME_ZONE } from './limits.ts';

export interface LocalTime {
  /** `YYYY-MM-DD` in America/Los_Angeles. */
  readonly date: string;
  /** 0 Sunday ... 6 Saturday. */
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
}

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface Parts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

function parts(ms: number): Parts {
  const values: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return {
    year: values['year'] ?? 1970,
    month: values['month'] ?? 1,
    day: values['day'] ?? 1,
    hour: (values['hour'] ?? 0) % 24,
    minute: values['minute'] ?? 0,
    second: values['second'] ?? 0,
  };
}

/** The zone's offset from UTC at `ms`, in milliseconds (negative west of Greenwich). */
export function zoneOffset(ms: number): number {
  const p = parts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** The local date, weekday and time of `ms`. */
export function localTime(ms: number): LocalTime {
  const p = parts(ms);
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return { date: `${String(p.year)}-${pad(p.month)}-${pad(p.day)}`, weekday, hour: p.hour, minute: p.minute };
}

/** The local date of `ms`, `YYYY-MM-DD`. */
export function localDate(ms: number): string {
  return localTime(ms).date;
}

/** The instant of a local date and `HH:MM` (valid for every time outside 01:00-03:00 on a DST day). */
export function localInstant(date: string, hhmm: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const wall = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0);
  // Two refinements: the offset at the guess, then at the corrected instant (they differ only near a change).
  let guess = wall - zoneOffset(wall);
  guess = wall - zoneOffset(guess);
  return guess;
}

/** The local date `days` after `date`. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
  return `${String(next.getUTCFullYear())}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** The weekday of a local date (0 Sunday). */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

/** The month of a local date, `YYYY-MM`. */
export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export type IssueKind = 'weekday' | 'deep_read';

/** The kind of issue a local date has, or null (Sunday). */
export function issueKind(date: string): IssueKind | null {
  const weekday = weekdayOf(date);
  if (weekday === 0) return null;
  return weekday === 6 ? 'deep_read' : 'weekday';
}

export type RoundKind = 'fetch' | 'cutoff';

export interface Round {
  /** `YYYY-MM-DDTHH:MM`, local. */
  readonly key: string;
  readonly date: string;
  readonly time: string;
  readonly kind: RoundKind;
  readonly at: number;
}

function roundsOf(date: string): Round[] {
  const rounds: Round[] = [];
  if (issueKind(date) !== null) rounds.push({ key: `${date}T${CUTOFF_ROUND}`, date, time: CUTOFF_ROUND, kind: 'cutoff', at: localInstant(date, CUTOFF_ROUND) });
  for (const time of FETCH_ROUNDS) rounds.push({ key: `${date}T${time}`, date, time, kind: 'fetch', at: localInstant(date, time) });
  return rounds;
}

/** The latest round at or before `now`. */
export function currentRound(now: number): Round {
  let date = localDate(now);
  for (let i = 0; i < 3; i++) {
    const due = roundsOf(date).filter((round) => round.at <= now);
    const last = due[due.length - 1];
    if (last !== undefined) return last;
    date = addDays(date, -1);
  }
  // Unreachable: every day has rounds.
  return roundsOf(date)[0] as Round;
}

/** The first round after `now`. */
export function nextRound(now: number): Round {
  let date = localDate(now);
  for (let i = 0; i < 3; i++) {
    const next = roundsOf(date).find((round) => round.at > now);
    if (next !== undefined) return next;
    date = addDays(date, 1);
  }
  return roundsOf(date)[0] as Round;
}

/** The cutoff instant of an issue date (03:30 local). */
export function cutoffOf(date: string): number {
  return localInstant(date, CUTOFF_ROUND);
}

/** The cutoff before the one of `date` (Sunday has none): Monday's is Saturday's. */
export function previousCutoffDate(date: string): string {
  let day = addDays(date, -1);
  while (issueKind(day) === null) day = addDays(day, -1);
  return day;
}

/** The weekday issue before `date`'s (Monday's is Friday's): the window of a weekday issue's new items. */
export function previousWeekdayDate(date: string): string {
  let day = addDays(date, -1);
  while (issueKind(day) !== 'weekday') day = addDays(day, -1);
  return day;
}

/**
 * Whether an arXiv paper (or its Hugging Face entry) first fetched at `fetchedAt` is eligible at the cutoff of `date`:
 * from the second cutoff after it was fetched, so the following day's corroboration (the day's Hugging Face list, the
 * posts that link it) is there when the order is computed (design §2). That is: fetched before the previous cutoff.
 */
export function arxivEligible(fetchedAt: number, date: string): boolean {
  return fetchedAt < cutoffOf(previousCutoffDate(date));
}

/** When the issue of `date` is sent: 06:30 on weekdays, 07:30 on Saturday. */
export function sendTimeOf(date: string): number {
  return localInstant(date, issueKind(date) === 'deep_read' ? SEND_SATURDAY : SEND_WEEKDAY);
}

/** The send cutoff of `date` (12:00): an issue ready later is only archived. */
export function sendCutoffOf(date: string): number {
  return localInstant(date, SEND_CUTOFF);
}

/** `issue_late` past this. */
export function lateTimeOf(date: string): number {
  return localInstant(date, LATE_TIME);
}

/** The last Sunday 12:00 at or before `now` (the weekly learning's slot), or 0 when none is within a week. */
export function lastLearnSlot(now: number): number {
  let date = localDate(now);
  for (let i = 0; i < 8; i++) {
    if (weekdayOf(date) === 0) {
      const at = localInstant(date, LEARN_TIME);
      if (at <= now) return at;
    }
    date = addDays(date, -1);
  }
  return 0;
}

/** The next instant something is scheduled after `now`: a round, a send time, the weekly learning. */
export function nextScheduled(now: number): number {
  const candidates = [nextRound(now).at];
  let date = localDate(now);
  for (let i = 0; i < 8; i++) {
    if (issueKind(date) !== null) candidates.push(sendTimeOf(date));
    if (weekdayOf(date) === 0) candidates.push(localInstant(date, LEARN_TIME));
    date = addDays(date, 1);
  }
  return Math.min(...candidates.filter((at) => at > now));
}

/** Noon to the next day's noon: 23 or 25 hours across a DST change (the tests read it). */
export function dayLength(date: string): number {
  return localInstant(addDays(date, 1), '12:00') - localInstant(date, '12:00');
}
