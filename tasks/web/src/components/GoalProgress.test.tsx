import { expect, it, vi } from "vitest";
import { goalDate } from "./GoalProgress";

it("uses account-local Today and shows the year on earlier progress or milestones", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T07:30:00Z"));
  const timestamp = (value: string) => ({
    seconds: BigInt(Date.parse(value) / 1000),
  });
  try {
    expect(
      goalDate(timestamp("2026-01-01T06:00:00Z"), "America/Los_Angeles"),
    ).toBe("Today");
    expect(
      goalDate(timestamp("2024-12-31T12:00:00Z"), "America/Los_Angeles"),
    ).toContain("2024");
  } finally {
    vi.useRealTimers();
  }
});
