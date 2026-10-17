import { describe, expect, it } from "vitest";
import { dateLabel, shiftDate, todayDate } from "./dates";
import { readRoute, routeHref } from "./routes";

describe("display dates and navigation", () => {
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
});
