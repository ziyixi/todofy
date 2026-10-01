import { describe, it, expect } from "vitest";
import {
  buildPomodoroPresets,
  MIN_SUGGESTED_MINS,
} from "@/lib/utils/pomodoro-presets";

describe("buildPomodoroPresets", () => {
  it("returns the fixed base list when no estimate is given", () => {
    const presets = buildPomodoroPresets();
    expect(presets.map((p) => p.mins)).toEqual([5, 30, 45, 60, 90, 120]);
    expect(presets.every((p) => !p.suggested)).toBe(true);
  });

  it("ignores null, undefined, zero, and negative estimates", () => {
    const baseMins = [5, 30, 45, 60, 90, 120];
    expect(buildPomodoroPresets(null).map((p) => p.mins)).toEqual(baseMins);
    expect(buildPomodoroPresets(undefined).map((p) => p.mins)).toEqual(baseMins);
    expect(buildPomodoroPresets(0).map((p) => p.mins)).toEqual(baseMins);
    expect(buildPomodoroPresets(-15).map((p) => p.mins)).toEqual(baseMins);
  });

  it("prepends a non-base estimate as the first, suggested preset", () => {
    const presets = buildPomodoroPresets(25);
    expect(presets[0]).toEqual({ mins: 25, label: "25m", suggested: true });
    expect(presets).toHaveLength(7);
    expect(presets.slice(1).map((p) => p.mins)).toEqual([5, 30, 45, 60, 90, 120]);
  });

  it("deduplicates when the estimate matches a base preset but still marks it suggested", () => {
    const presets = buildPomodoroPresets(45);
    expect(presets).toHaveLength(6);
    expect(presets[0]).toEqual({ mins: 45, label: "45m", suggested: true });
    const fortyFives = presets.filter((p) => p.mins === 45);
    expect(fortyFives).toHaveLength(1);
  });

  it("labels multi-hour estimates using formatDuration conventions", () => {
    expect(buildPomodoroPresets(90)[0].label).toBe("1h 30m");
    expect(buildPomodoroPresets(120)[0].label).toBe("2h");
    expect(buildPomodoroPresets(15)[0].label).toBe("15m");
  });

  it("subtracts already-logged time from the suggested estimate", () => {
    // 45m estimate, 20m already logged -> suggest 25m for what's left.
    const presets = buildPomodoroPresets(45, 20);
    expect(presets[0]).toEqual({ mins: 25, label: "25m", suggested: true });
    // The base 25m doesn't exist; base list is intact otherwise.
    expect(presets.slice(1).map((p) => p.mins)).toEqual([5, 30, 45, 60, 90, 120]);
  });

  it("floors the suggested preset at MIN_SUGGESTED_MINS once you're near the estimate", () => {
    expect(MIN_SUGGESTED_MINS).toBe(5);
    // Remaining = 2 -> clamped to 5; dedupes against base 5.
    const tightlyOver = buildPomodoroPresets(45, 43);
    expect(tightlyOver[0]).toEqual({ mins: 5, label: "5m", suggested: true });
    expect(tightlyOver).toHaveLength(6);
    // Already over the estimate also clamps to the floor instead of going negative.
    const wayOver = buildPomodoroPresets(30, 90);
    expect(wayOver[0].mins).toBe(5);
    expect(wayOver[0].suggested).toBe(true);
  });

  it("treats null/zero/negative loggedMins as zero", () => {
    expect(buildPomodoroPresets(45, null)[0].mins).toBe(45);
    expect(buildPomodoroPresets(45, 0)[0].mins).toBe(45);
    expect(buildPomodoroPresets(45, -10)[0].mins).toBe(45);
  });
});
