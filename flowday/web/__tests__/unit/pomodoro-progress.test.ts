import { describe, expect, it } from "vitest";
import { derivePomodoroLoggedSeconds } from "@/lib/utils/pomodoro-progress";

describe("derivePomodoroLoggedSeconds", () => {
  it("returns null when there is no active pomodoro target", () => {
    expect(derivePomodoroLoggedSeconds(120, null, 1800)).toBeNull();
  });

  it("preserves previously logged time when a pomodoro has just started", () => {
    expect(derivePomodoroLoggedSeconds(120, 1800, 1800)).toBe(120);
  });

  it("adds elapsed pomodoro time on top of prior logged time", () => {
    expect(derivePomodoroLoggedSeconds(120, 1800, 1680)).toBe(240);
  });

  it("clamps at zero if remaining time is unexpectedly above target", () => {
    expect(derivePomodoroLoggedSeconds(0, 1800, 1900)).toBe(0);
  });
});
