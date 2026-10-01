import { describe, it, expect } from "vitest";
import { formatDuration, formatElapsed } from "@/lib/utils/time";

describe("formatDuration", () => {
  it("returns 0m for zero", () => {
    expect(formatDuration(0)).toBe("0m");
  });

  it("returns 0m for negative", () => {
    expect(formatDuration(-5)).toBe("0m");
  });

  it("formats minutes only", () => {
    expect(formatDuration(45)).toBe("45m");
  });

  it("formats hours only", () => {
    expect(formatDuration(120)).toBe("2h");
  });

  it("formats hours and minutes", () => {
    expect(formatDuration(90)).toBe("1h 30m");
  });

  it("handles large values", () => {
    expect(formatDuration(610)).toBe("10h 10m");
  });
});

describe("formatElapsed", () => {
  it("formats seconds only", () => {
    expect(formatElapsed(5)).toBe("0:05");
  });

  it("formats minutes and seconds", () => {
    expect(formatElapsed(75)).toBe("1:15");
  });

  it("formats hours minutes seconds", () => {
    expect(formatElapsed(3661)).toBe("1:01:01");
  });

  it("pads correctly", () => {
    expect(formatElapsed(3600)).toBe("1:00:00");
  });
});
