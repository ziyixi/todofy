import { describe, expect, it } from "vitest";
import {
  buildTimeOptions,
  defaultManualEntryRange,
  roundDownToHalfHour,
} from "@/lib/utils/manual-entry-time";

describe("manual entry time helpers", () => {
  it("rounds down to the previous 30-minute block", () => {
    const rounded = roundDownToHalfHour(new Date("2026-04-21T09:43:12"));
    expect(rounded.getHours()).toBe(9);
    expect(rounded.getMinutes()).toBe(30);
    expect(rounded.getSeconds()).toBe(0);
  });

  it("defaults add-entry range to the nearest 30-minute block", () => {
    const range = defaultManualEntryRange(new Date("2026-04-21T09:43:12"));
    expect(range.start).toEqual({
      dateValue: "2026-04-21",
      timeValue: "09:30",
    });
    expect(range.end).toEqual({
      dateValue: "2026-04-21",
      timeValue: "10:00",
    });
  });

  it("handles end-of-day rollover when computing the default end block", () => {
    const range = defaultManualEntryRange(new Date("2026-04-21T23:50:00"));
    expect(range.start).toEqual({
      dateValue: "2026-04-21",
      timeValue: "23:30",
    });
    expect(range.end).toEqual({
      dateValue: "2026-04-22",
      timeValue: "00:00",
    });
  });

  it("keeps off-grid edited times available in the selector", () => {
    const options = buildTimeOptions(["09:17"]);
    expect(options).toContain("09:17");
    expect(options).toContain("09:00");
    expect(options).toContain("09:30");
  });
});
