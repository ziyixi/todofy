import { expect, it } from "vitest";
import { readRepeat, writeRepeat } from "./recurrence-controls";

it("keeps completion-based imported rules and monthly February behavior", () => {
  expect(readRepeat("every day", "2026-10-18").afterCompletion).toBe(true);
  const monthly = readRepeat("every 30th", "2026-01-30");
  expect(writeRepeat(monthly)).toBe(
    "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=30,-1;BYSETPOS=1",
  );
});
it("represents weekly multi-day rules without free text", () => {
  const value = readRepeat(
    "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR",
    "2026-10-18",
  );
  expect(value.days).toEqual(["MO", "FR"]);
  expect(writeRepeat(value)).toBe("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR");
});
it("preserves a custom imported rule until a different frequency is chosen", () => {
  const rule = "RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1";
  expect(writeRepeat(readRepeat(rule, "2026-10-18"))).toBe(rule);
});

it("retains a yearly calendar month even when the current task date was moved", () => {
  const value = readRepeat(
    "RRULE:FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=6",
    "2026-01-02",
  );
  expect(writeRepeat({ ...value, interval: 2 })).toBe(
    "RRULE:FREQ=YEARLY;INTERVAL=2;BYMONTH=4;BYMONTHDAY=6",
  );
  expect(readRepeat("every 6th April", "2026-01-02").month).toBe(4);
});
