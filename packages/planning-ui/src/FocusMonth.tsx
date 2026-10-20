import { addDays, mondayOf, monthStart } from "./domain";
import { dayTotals, monthStats } from "./focus-stats";
import { dayName, loggedMinutes, StatsRow, TimeGroups } from "./FocusWeek";
import { words } from "./i18n";
import { readableDate, shortDay } from "./PlanningCalendar";
import type { FocusRange, Language } from "./model";

/** A day's shade by its logged time: none, up to an hour, up to three hours, more. */
function level(seconds: number): number {
  if (!seconds) return 0;
  if (seconds <= 60 * 60) return 1;
  return seconds <= 3 * 60 * 60 ? 2 : 3;
}

/**
 * Focus's Month: its numbers, a Monday-first calendar shaded by each day's logged time in a neutral
 * ink ramp, and where the time went. Days of the neighbouring months are faded and count in
 * nothing. A day opens in Day.
 */
export function FocusMonth({
  range,
  month,
  today,
  language,
  onOpenDay,
}: {
  /** The month's days, read from its first to its last. */
  range: FocusRange;
  /** YYYY-MM. */
  month: string;
  today: string;
  language: Language;
  onOpenDay: (date: string) => void;
}) {
  const text = words(language);
  const days = range.days.filter((day) => day.date.slice(0, 7) === month);
  const byDate = new Map(days.map((day) => [day.date, day]));
  const stats = monthStats(days, month, range.tasks);
  const first = `${month}-01`;
  const last = addDays(monthStart(first, 1), -1);
  const cells: string[] = [];
  for (
    let date = mondayOf(first);
    date <= addDays(mondayOf(last), 6);
    date = addDays(date, 1)
  )
    cells.push(date);
  return (
    <>
      <StatsRow stats={stats} language={language} />
      <div className="plus-focus-month">
        {cells.slice(0, 7).map((date) => (
          <span key={date} className="plus-focus-weekday" aria-hidden="true">
            {shortDay(date, language)}
          </span>
        ))}
        {cells.map((date) => {
          const day = byDate.get(date);
          if (date.slice(0, 7) !== month)
            return (
              <span
                key={date}
                className="plus-focus-month-day is-outside"
                aria-hidden="true"
              >
                <span>{Number(date.slice(8))}</span>
              </span>
            );
          const seconds = day ? dayTotals(day).total : 0;
          return (
            <button
              key={date}
              type="button"
              className={`plus-focus-month-day ${date === today ? "is-today" : ""}`}
              data-level={level(seconds)}
              aria-label={
                day ? dayName(day, language) : readableDate(date, language)
              }
              onClick={() => onOpenDay(date)}
            >
              <span>{Number(date.slice(8))}</span>
              {seconds > 0 && <span>{loggedMinutes(seconds)}</span>}
            </button>
          );
        })}
      </div>
      {stats.total === 0 && <p className="plus-muted">{text.noTimeMonth}</p>}
      <TimeGroups days={days} tasks={range.tasks} language={language} />
    </>
  );
}
