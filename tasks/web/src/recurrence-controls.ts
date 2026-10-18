export type RepeatFrequency =
  "none" | "daily" | "weekdays" | "weekly" | "monthly" | "yearly";
export interface RepeatOptions {
  frequency: RepeatFrequency;
  interval: number;
  days: string[];
  monthDay: number;
  month: number;
  afterCompletion: boolean;
  preserved?: string;
}
export const REPEAT_DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

/** The editor changes a calendar rule; date advancement remains the Worker's responsibility. */
export function readRepeat(value: string, date: string): RepeatOptions {
  const reference = new Date(`${date || "2026-01-01"}T12:00:00Z`);
  const base: RepeatOptions = {
    frequency: value ? "daily" : "none",
    interval: 1,
    days: [REPEAT_DAYS[(reference.getUTCDay() + 6) % 7]!],
    monthDay: reference.getUTCDate(),
    month: reference.getUTCMonth() + 1,
    afterCompletion: false,
  };
  if (!value) return base;
  const normalized = value.trim().toLowerCase();
  if (/^rrule:/i.test(value)) {
    const fields: Record<string, string> = Object.fromEntries(
      value
        .slice(6)
        .toUpperCase()
        .split(";")
        .map((part) => part.split("=")),
    );
    const frequency = fields.FREQ?.toLowerCase();
    if (!["daily", "weekly", "monthly", "yearly"].includes(frequency || ""))
      return { ...base, preserved: value };
    const allowed = new Set([
      "FREQ",
      "INTERVAL",
      "BYDAY",
      "BYMONTHDAY",
      "BYSETPOS",
      "BYMONTH",
    ]);
    if (Object.keys(fields).some((key) => !allowed.has(key)))
      return { ...base, preserved: value };
    const days = fields.BYDAY?.split(",");
    if (
      days?.some(
        (day) => !REPEAT_DAYS.includes(day as (typeof REPEAT_DAYS)[number]),
      )
    )
      return { ...base, preserved: value };
    const monthDays = fields.BYMONTHDAY?.split(",").map(Number);
    if (
      (frequency === "daily" &&
        (fields.BYDAY || fields.BYMONTHDAY || fields.BYMONTH)) ||
      (frequency === "weekly" && (fields.BYMONTHDAY || fields.BYMONTH)) ||
      (frequency === "monthly" && (fields.BYDAY || fields.BYMONTH)) ||
      (frequency === "yearly" &&
        (fields.BYDAY ||
          fields.BYSETPOS ||
          fields.BYMONTH?.includes(",") ||
          (monthDays && monthDays.length !== 1)))
    )
      return { ...base, preserved: value };
    if (
      fields.BYSETPOS &&
      (fields.BYSETPOS !== "1" || !monthDays?.includes(-1))
    )
      return { ...base, preserved: value };
    return {
      ...base,
      frequency: frequency as RepeatFrequency,
      interval: Number(fields.INTERVAL || 1),
      days: days || base.days,
      month: Number(fields.BYMONTH || base.month),
      monthDay:
        monthDays?.find((day) => day > 0) ||
        (monthDays?.includes(-1) ? -1 : base.monthDay),
    };
  }
  if (["every weekday", "every workday"].includes(normalized))
    return { ...base, frequency: "weekdays" };
  const aliases: Record<string, string> = {
    daily: "every day",
    weekly: "every week",
    monthly: "every month",
    yearly: "every year",
    quarterly: "every 3 months",
  };
  const text = aliases[normalized] || normalized;
  const interval = /^every(!)? (?:(\d+) )?(day|week|month|year)s?$/.exec(text);
  if (interval)
    return {
      ...base,
      frequency: (
        {
          day: "daily",
          week: "weekly",
          month: "monthly",
          year: "yearly",
        } as const
      )[interval[3] as "day" | "week" | "month" | "year"],
      interval: Number(interval[2] || 1),
      afterCompletion:
        Boolean(interval[1]) || text === "every day" || text === "every week",
    };
  const weekday =
    /^every (?:(\d+) weeks? )?(mon|tue|wed|thu|fri|sat|sun)[a-z]*$/.exec(text);
  if (weekday)
    return {
      ...base,
      frequency: "weekly",
      interval: Number(weekday[1] || 1),
      days: [weekday[2]!.slice(0, 2).toUpperCase()],
    };
  if (text === "every 30th")
    return { ...base, frequency: "monthly", monthDay: 30 };
  const annual = /^every (\d+)(?:st|nd|rd|th) ([a-z]+)$/.exec(text);
  if (annual) {
    const month =
      [
        "jan",
        "feb",
        "mar",
        "apr",
        "may",
        "jun",
        "jul",
        "aug",
        "sep",
        "oct",
        "nov",
        "dec",
      ].indexOf(annual[2]!.slice(0, 3)) + 1;
    return { ...base, frequency: "yearly", monthDay: Number(annual[1]), month };
  }
  return { ...base, preserved: value };
}

export function writeRepeat(value: RepeatOptions): string {
  if (value.preserved) return value.preserved;
  if (value.frequency === "none") return "";
  if (value.frequency === "weekdays")
    return "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
  const unit = {
    daily: "day",
    weekly: "week",
    monthly: "month",
    yearly: "year",
  }[value.frequency];
  if (value.afterCompletion)
    return `every! ${value.interval} ${unit}${value.interval === 1 ? "" : "s"}`;
  let result = `RRULE:FREQ=${value.frequency.toUpperCase()};INTERVAL=${value.interval}`;
  if (value.frequency === "weekly")
    result += `;BYDAY=${REPEAT_DAYS.filter((day) => value.days.includes(day)).join(",") || value.days[0] || "MO"}`;
  if (value.frequency === "monthly")
    result +=
      value.monthDay === -1
        ? ";BYMONTHDAY=-1"
        : `;BYMONTHDAY=${value.monthDay},-1;BYSETPOS=1`;
  if (value.frequency === "yearly")
    result += `;BYMONTH=${value.month};BYMONTHDAY=${value.monthDay}`;
  return result;
}
