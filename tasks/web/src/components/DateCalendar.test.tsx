import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DateCalendar } from "./DateCalendar";
import { SchedulePicker } from "./SchedulePicker";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("chooses the exact date across month and DST boundaries", () => {
  const choose = vi.fn();
  render(
    <DateCalendar
      value="2026-10-31"
      today="2026-10-17"
      disabled={false}
      onChange={choose}
    />,
  );
  const next = screen.getByRole("gridcell", {
    name: "Sunday, November 1, 2026",
  });
  fireEvent.click(next);
  expect(choose).toHaveBeenCalledWith("2026-11-01");
  fireEvent.click(screen.getByRole("button", { name: "Next month" }));
  expect(screen.getByText("November 2026")).toBeTruthy();
  expect(
    screen.getByRole("gridcell", { name: "Sunday, November 1, 2026" }).tabIndex,
  ).toBe(0);
});

it("navigates the calendar with arrow keys without selecting a date", () => {
  const choose = vi.fn();
  render(
    <DateCalendar
      value="2026-03-08"
      today="2026-03-01"
      disabled={false}
      onChange={choose}
    />,
  );
  fireEvent.keyDown(
    screen.getByRole("gridcell", { name: "Sunday, March 8, 2026" }),
    { key: "ArrowRight" },
  );
  expect(
    screen.getByRole("gridcell", { name: "Monday, March 9, 2026" }).tabIndex,
  ).toBe(0);
  expect(choose).not.toHaveBeenCalled();
});

it("starts rows on Sunday and Home/End stay inside a Sunday-to-Saturday row", () => {
  render(
    <DateCalendar
      value="2026-10-14"
      today="2026-10-14"
      disabled={false}
      onChange={vi.fn()}
    />,
  );
  expect(
    screen.getAllByRole("columnheader").map((cell) => cell.textContent),
  ).toEqual(["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]);
  const wednesday = screen.getByRole("gridcell", {
    name: "Wednesday, October 14, 2026",
  });
  fireEvent.keyDown(wednesday, { key: "Home" });
  expect(
    screen.getByRole("gridcell", { name: "Sunday, October 11, 2026" }).tabIndex,
  ).toBe(0);
  fireEvent.keyDown(wednesday, { key: "End" });
  expect(
    screen.getByRole("gridcell", { name: "Saturday, October 17, 2026" })
      .tabIndex,
  ).toBe(0);
});

it.each([
  ['2026-10-24T19:00:00Z', '2026-10-25'],
  ['2026-10-25T19:00:00Z', '2026-11-01'],
])('Next week selects a strictly future Sunday from %s', (now, expected) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  const choose = vi.fn();
  render(<SchedulePicker label="Date" value="" open onOpenChange={vi.fn()} disabled={false}
    timeZone="America/Los_Angeles" onChange={choose} />);
  fireEvent.click(screen.getByRole('button', { name: /^Next week/u }));
  expect(choose).toHaveBeenCalledWith(expected);
});
