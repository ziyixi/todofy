import { expect, it } from "vitest";
import { readRepeat, repeatLabel, writeRepeat } from "./recurrence-controls";

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

it("summarizes rules in words, including the month-end rule the Worker stores", () => {
  expect(repeatLabel("")).toBe("Repeat");
  expect(repeatLabel("every Tuesday")).toBe("Weekly");
  expect(repeatLabel("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR")).toBe(
    "Every 2 weeks",
  );
  expect(repeatLabel("every! 2 weeks")).toBe(
    "Every 2 weeks · after completion",
  );
  expect(repeatLabel("every month")).toBe("Monthly");
  expect(
    repeatLabel("RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=31,-1;BYSETPOS=1"),
  ).toBe("Monthly on the 31st (or last day)");
  expect(
    repeatLabel("RRULE:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=30,-1;BYSETPOS=1"),
  ).toBe("Every 3 months on the 30th (or last day)");
  expect(
    repeatLabel("RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=5,-1;BYSETPOS=1"),
  ).toBe("Monthly");
  expect(repeatLabel("RRULE:FREQ=MONTHLY;BYMONTHDAY=-1")).toBe(
    "Monthly on the last day",
  );
  expect(repeatLabel("RRULE:FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1")).toBe(
    "Custom repeat",
  );
});

it("edits a clamped Feb 29 yearly rule as yearly and keeps its last-day fallback", () => {
  const rule =
    "RRULE:FREQ=YEARLY;INTERVAL=1;BYMONTH=2;BYMONTHDAY=29,-1;BYSETPOS=1";
  const value = readRepeat(rule, "2028-02-29");
  expect([value.frequency, value.month, value.monthDay]).toEqual([
    "yearly",
    2,
    29,
  ]);
  expect(writeRepeat(value)).toBe(rule);
  expect(repeatLabel(rule)).toBe("Yearly");
  expect(
    readRepeat("RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=5,-1", "2028-02-05")
      .preserved,
  ).toBeTruthy();
});
