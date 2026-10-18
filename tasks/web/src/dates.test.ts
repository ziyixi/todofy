import { describe, expect, it } from "vitest";
import { dateLabel, shiftDate, todayDate } from "./dates";
import { readRoute, routeHref } from "./routes";

describe("display dates and navigation", () => {
  it("shows the year outside the account's current year, including both sides of New Year", () => {
    expect(dateLabel("2030-04-22", "2026-10-18")).toContain("2030");
    expect(dateLabel("2025-12-31", "2026-01-01")).toContain("2025");
    expect(dateLabel("2027-01-01", "2026-12-31")).toContain("2027");
    expect(dateLabel("2026-04-22", "2026-10-18")).not.toContain("2026");
    expect(dateLabel("2026-10-18", "2026-10-18")).toBe("Today");
  });
  it("keeps date-only tasks on the same calendar day across a daylight-saving change", () => {
    expect(shiftDate("2026-03-07", 1)).toBe("2026-03-08");
    expect(shiftDate("2026-03-08", 1)).toBe("2026-03-09");
    expect(todayDate(new Date(2026, 0, 2, 0, 1))).toBe("2026-01-02");
    expect(dateLabel("2026-10-17", "2026-10-17")).toBe("Today");
  });
  it("restores encoded project identifiers and rejects unknown navigation pages", () => {
    const route = { page: "project" as const, id: "local-2026" };
    expect(readRoute(routeHref(route))).toEqual(route);
    expect(readRoute("#/unknown/private").page).toBe("today");
  });
  it("uses the account calendar day for schedule shortcuts around midnight and DST", () => {
    expect(
      todayDate(new Date("2026-11-01T06:30:00Z"), "America/Los_Angeles"),
    ).toBe("2026-10-31");
    expect(
      todayDate(new Date("2026-11-01T09:30:00Z"), "America/Los_Angeles"),
    ).toBe("2026-11-01");
    expect(shiftDate("2026-10-31", 1)).toBe("2026-11-01");
    expect(shiftDate("2026-11-01", 1)).toBe("2026-11-02");
  });
});
