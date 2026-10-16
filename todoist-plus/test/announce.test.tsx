import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ANNOUNCE_AGAIN_MS, useAnnouncement } from "../src/announce";

afterEach(() => {
  vi.useRealTimers();
});

it("changes the live region for every announcement, the same message twice included", () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useAnnouncement());
  expect(result.current[0]).toBe("");
  act(() => result.current[1]("Work goal saved"));
  expect(result.current[0]).toBe("Work goal saved");
  // The same again: cleared first, then set, so a screen reader hears it a second time.
  act(() => result.current[1]("Work goal saved"));
  expect(result.current[0]).toBe("");
  act(() => vi.advanceTimersByTime(ANNOUNCE_AGAIN_MS));
  expect(result.current[0]).toBe("Work goal saved");
  // Another message replaces it at once, and one that comes while a repeat waits wins.
  act(() => result.current[1]("Work goal saved"));
  act(() => result.current[1]("Personal goal saved"));
  expect(result.current[0]).toBe("Personal goal saved");
  act(() => vi.advanceTimersByTime(ANNOUNCE_AGAIN_MS));
  expect(result.current[0]).toBe("Personal goal saved");
});
