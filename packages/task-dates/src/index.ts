import { en } from 'chrono-node';
import * as recurrenceLibrary from 'rrule';
import type { Options, RRule as RecurrenceRule } from 'rrule';
// rrule publishes ESM for Worker bundlers and a CommonJS default for Node import tools.
const recurrenceModule = recurrenceLibrary as unknown as {
  RRule?: typeof RecurrenceRule;
  default?: { RRule: typeof RecurrenceRule };
};
const RRule: typeof RecurrenceRule = (() => {
  const constructor = recurrenceModule.RRule ?? recurrenceModule.default?.RRule;
  if (!constructor) throw new Error('rrule constructor is unavailable');
  return constructor;
})();

export class TaskDateError extends Error {}
export interface TaskDate {
  dueDate: string;
  dueDatetime: string;
  dueTimezone: string;
  recurrence: string;
}
const DAY = 86_400_000;
const weekdays = {
  mon: RRule.MO,
  tue: RRule.TU,
  wed: RRule.WE,
  thu: RRule.TH,
  fri: RRule.FR,
  sat: RRule.SA,
  sun: RRule.SU,
} as const;
const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export function validDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let value = formatters.get(zone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(zone, value);
  }
  return value;
}
export function validTimezone(zone: string): boolean {
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}
export function localDate(now: number, zone: string): string {
  try {
    return wallParts(new Date(now), zone).slice(0, 10);
  } catch {
    throw new TaskDateError('Unsupported timezone');
  }
}
export function addDays(date: string, days: number): string {
  if (!validDate(date)) throw new TaskDateError('Invalid date');
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}
function calendar(date: string): Date {
  return new Date(`${date}T00:00:00Z`);
}

/** Keep the supported grammar explicit: an unrecognized Todoist expression blocks import acceptance. */
export function recurrenceRule(text: string, start: string): { rule: RecurrenceRule; afterCompletion: boolean } {
  if (!validDate(start) || text.length > 200) throw new TaskDateError('Invalid recurrence');
  const aliases: Record<string, string> = {
    daily: 'every day',
    everyday: 'every day',
    weekly: 'every week',
    monthly: 'every month',
    yearly: 'every year',
    quarterly: 'every 3 months',
  };
  const raw = text.trim().toLowerCase();
  const normalized = aliases[raw] ?? raw;
  const afterCompletion = normalized.startsWith('every!') || normalized === 'every day' || normalized === 'every week';
  const plain = normalized.replace(/^every!/, 'every');
  let ruleStart = calendar(start);
  let options: Partial<Options>;
  if (/^rrule:/i.test(text)) {
    if (
      !/^RRULE:FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+-]+)*$/i.test(text) ||
      /;(COUNT|UNTIL|BYHOUR|BYMINUTE|BYSECOND)=/i.test(text)
    )
      throw new TaskDateError('Unsupported recurrence rule');
    options = RRule.parseString(text.toUpperCase());
  } else if (/^every (weekday|workday)$/.test(plain)) {
    options = {
      freq: RRule.WEEKLY,
      byweekday: [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR],
    };
  } else {
    const interval = /^every (?:(\d{1,3}) )?(day|days|week|weeks|month|months|year|years)$/.exec(plain);
    const weekday =
      /^every (?:(\d{1,3}) weeks? )?(mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)$/.exec(
        plain,
      );
    const annual = /^every (\d{1,2})(?:st|nd|rd|th) (jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/.exec(plain);
    if (interval) {
      const frequencies = {
        day: RRule.DAILY,
        week: RRule.WEEKLY,
        month: RRule.MONTHLY,
        year: RRule.YEARLY,
      };
      const unit = interval[2]!.replace(/s$/, '') as keyof typeof frequencies;
      options = { freq: frequencies[unit], interval: Number(interval[1] ?? 1) };
    } else if (weekday) {
      if (afterCompletion) throw new TaskDateError('Completion-based weekday rules are not supported');
      const byweekday = weekdays[weekday[2]!.slice(0, 3) as keyof typeof weekdays];
      options = {
        freq: RRule.WEEKLY,
        interval: Number(weekday[1] ?? 1),
        byweekday: [byweekday],
      };
      // A newly entered biweekly rule starts on the next named weekday, then repeats every N weeks.
      ruleStart = new RRule({ freq: RRule.WEEKLY, byweekday: [byweekday], dtstart: ruleStart }, true).after(ruleStart, true)!;
    } else if (annual) {
      if (afterCompletion) throw new TaskDateError('Completion-based calendar dates are not supported');
      const month = months.indexOf(annual[2]!.slice(0, 3)) + 1;
      const day = Number(annual[1]);
      if (!validDate(`2000-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`))
        throw new TaskDateError('Invalid annual calendar date');
      options = { freq: RRule.YEARLY, bymonth: month, bymonthday: day };
    } else throw new TaskDateError('Unsupported recurrence; choose an explicit supported rule');
  }
  if ((options.interval ?? 1) < 1 || (options.interval ?? 1) > 365)
    throw new TaskDateError('Recurrence interval out of range');
  return {
    rule: new RRule({ ...options, dtstart: ruleStart }, true),
    afterCompletion,
  };
}

function wallParts(instant: Date, zone: string): string {
  const parts = formatter(zone).formatToParts(instant);
  const part = (key: string) => parts.find((p) => p.type === key)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`;
}
/** Resolve a local clock in an IANA zone. Reject nonexistent DST times instead of silently changing them. */
export function zonedInstant(wall: string, zone: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(wall) || !validDate(wall.slice(0, 10)) || !validTimezone(zone))
    throw new TaskDateError('Invalid local date-time');
  const desired = Date.parse(`${wall}Z`);
  let candidate = desired;
  for (let attempt = 0; attempt < 4; attempt++) {
    const observed = Date.parse(`${wallParts(new Date(candidate), zone)}Z`);
    const correction = desired - observed;
    if (correction === 0) return new Date(candidate).toISOString();
    candidate += correction;
  }
  throw new TaskDateError('This local time does not exist in the selected timezone');
}

export function previewDate(text: string, referenceDate: string, zone: string): TaskDate {
  if (!validDate(referenceDate) || !validTimezone(zone) || !text.trim() || text.length > 200)
    throw new TaskDateError('Invalid date input');
  if (
    /^(every!?\s|rrule:)/i.test(text.trim()) ||
    /^(daily|everyday|weekly|monthly|yearly|quarterly)$/i.test(text.trim())
  ) {
    const { rule } = recurrenceRule(text, referenceDate);
    const first = rule.after(calendar(referenceDate), true);
    if (!first) throw new TaskDateError('Recurrence has no next occurrence');
    return {
      dueDate: first.toISOString().slice(0, 10),
      dueDatetime: '',
      dueTimezone: '',
      recurrence: text.trim(),
    };
  }
  const result = en.casual.parse(text, { instant: calendar(referenceDate), timezone: 0 }, { forwardDate: true });
  if (result.length !== 1 || result[0]!.index !== 0 || result[0]!.text.trim() !== text.trim() || result[0]!.end)
    throw new TaskDateError('Enter one complete date');
  const parsed = result[0]!.start;
  const dueDate = `${parsed.get('year')}-${String(parsed.get('month')).padStart(2, '0')}-${String(parsed.get('day')).padStart(2, '0')}`;
  if (!validDate(dueDate)) throw new TaskDateError('Invalid date');
  if (!parsed.isCertain('hour')) return { dueDate, dueDatetime: '', dueTimezone: '', recurrence: '' };
  const wall = `${dueDate}T${String(parsed.get('hour')).padStart(2, '0')}:${String(parsed.get('minute') ?? 0).padStart(2, '0')}:00`;
  return {
    dueDate,
    dueDatetime: zonedInstant(wall, zone),
    dueTimezone: zone,
    recurrence: '',
  };
}

export function nextOccurrence(current: TaskDate, completedAt: number, accountZone: string): TaskDate {
  if (!current.recurrence) throw new TaskDateError('Task is not recurring');
  const today = localDate(completedAt, current.dueTimezone || accountZone);
  const anchored = recurrenceRule(current.recurrence, current.dueDate);
  const rule = anchored.afterCompletion ? recurrenceRule(current.recurrence, today).rule : anchored.rule;
  const reference = anchored.afterCompletion ? today : current.dueDate > today ? current.dueDate : today;
  const next = rule.after(calendar(reference), false);
  if (!next) throw new TaskDateError('Recurrence has no next occurrence');
  const dueDate = next.toISOString().slice(0, 10);
  let dueDatetime = '';
  if (current.dueDatetime) {
    const clock = wallParts(new Date(current.dueDatetime), current.dueTimezone).slice(11);
    dueDatetime = zonedInstant(`${dueDate}T${clock}`, current.dueTimezone);
  }
  return { ...current, dueDate, dueDatetime };
}
