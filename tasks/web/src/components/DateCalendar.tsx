import { useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { shiftDate, todayDate } from "../dates";

export function DateCalendar({
  value,
  today,
  disabled,
  onChange,
}: {
  value: string;
  today: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const [month, setMonth] = useState((value || today).slice(0, 7));
  const [focused, setFocused] = useState(value || today);
  const grid = useRef<HTMLDivElement>(null);
  const first = `${month}-01`;
  const firstDay = new Date(`${first}T12:00:00`);
  const start = shiftDate(first, -firstDay.getDay());
  const days = Array.from({ length: 42 }, (_, index) =>
    shiftDate(start, index),
  );
  function moveMonth(amount: number) {
    const next = new Date(`${first}T12:00:00`);
    next.setMonth(next.getMonth() + amount);
    setMonth(todayDate(next).slice(0, 7));
    setFocused(todayDate(next));
  }
  function navigate(event: KeyboardEvent<HTMLButtonElement>, date: string) {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[
      event.key
    ];
    let next = "";
    if (step !== undefined) next = shiftDate(date, step);
    else if (event.key === "Home")
      next = shiftDate(date, -new Date(`${date}T12:00:00`).getDay());
    else if (event.key === "End")
      next = shiftDate(date, 6 - new Date(`${date}T12:00:00`).getDay());
    if (!next) return;
    event.preventDefault();
    setMonth(next.slice(0, 7));
    setFocused(next);
    window.requestAnimationFrame(() =>
      grid.current
        ?.querySelector<HTMLButtonElement>(`[data-date="${next}"]`)
        ?.focus(),
    );
  }
  return (
    <div className="date-calendar">
      <div className="calendar-heading">
        <span aria-live="polite">
          {firstDay.toLocaleDateString("en", {
            month: "long",
            year: "numeric",
          })}
        </span>
        <button
          type="button"
          className="calendar-nav"
          aria-label="Previous month"
          onClick={() => moveMonth(-1)}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          type="button"
          className="calendar-nav"
          aria-label="Next month"
          onClick={() => moveMonth(1)}
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <div
        className="calendar-grid"
        role="grid"
        aria-label="Choose a date"
        ref={grid}
      >
        <div role="row" className="calendar-week">
          {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((day) => (
            <span role="columnheader" className="calendar-weekday" key={day}>
              {day}
            </span>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, week) => (
          <div role="row" className="calendar-week" key={week}>
            {days.slice(week * 7, week * 7 + 7).map((date) => (
              <button
                type="button"
                role="gridcell"
                key={date}
                data-date={date}
                aria-label={new Date(`${date}T12:00:00`).toLocaleDateString(
                  "en",
                  { dateStyle: "full" },
                )}
                aria-selected={date === value}
                aria-current={date === today ? "date" : undefined}
                tabIndex={date === focused ? 0 : -1}
                disabled={disabled}
                className={`calendar-day${date.slice(0, 7) !== month ? " is-outside-month" : ""}`}
                onFocus={() => setFocused(date)}
                onKeyDown={(event) => navigate(event, date)}
                onClick={() => onChange(date)}
              >
                {Number(date.slice(8))}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
