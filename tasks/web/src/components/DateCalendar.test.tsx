import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DateCalendar } from "./DateCalendar";

afterEach(cleanup);

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
