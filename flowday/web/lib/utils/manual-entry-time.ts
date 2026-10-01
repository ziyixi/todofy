const HALF_HOUR_MS = 30 * 60 * 1000;

export interface LocalDateTimeParts {
  dateValue: string;
  timeValue: string;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

export function timeValueFromDate(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function dateValueFromDate(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function roundDownToHalfHour(date: Date): Date {
  const rounded = new Date(date);
  rounded.setSeconds(0, 0);
  rounded.setMinutes(rounded.getMinutes() - (rounded.getMinutes() % 30));
  return rounded;
}

export function toLocalDateTimeParts(iso: string): LocalDateTimeParts {
  const date = new Date(iso);
  return {
    dateValue: dateValueFromDate(date),
    timeValue: timeValueFromDate(date),
  };
}

export function defaultManualEntryRange(now: Date): {
  start: LocalDateTimeParts;
  end: LocalDateTimeParts;
} {
  const start = roundDownToHalfHour(now);
  const end = new Date(start.getTime() + HALF_HOUR_MS);
  return {
    start: {
      dateValue: dateValueFromDate(start),
      timeValue: timeValueFromDate(start),
    },
    end: {
      dateValue: dateValueFromDate(end),
      timeValue: timeValueFromDate(end),
    },
  };
}

export function buildTimeOptions(extraTimes: string[] = []): string[] {
  const options = new Set<string>();
  for (let hour = 0; hour < 24; hour++) {
    options.add(`${pad(hour)}:00`);
    options.add(`${pad(hour)}:30`);
  }
  for (const time of extraTimes) {
    if (/^\d{2}:\d{2}$/.test(time)) {
      options.add(time);
    }
  }
  return Array.from(options).sort();
}

export function combineLocalDateAndTime(dateValue: string, timeValue: string): string {
  return new Date(`${dateValue}T${timeValue}`).toISOString();
}
