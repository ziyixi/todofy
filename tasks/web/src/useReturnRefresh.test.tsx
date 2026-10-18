import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RETURN_REFRESH_MS, useReturnRefresh } from "./useReturnRefresh";

let visibility: DocumentVisibilityState = "visible";
beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function show(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

it("refreshes after a minute hidden, but not after a short switch away", () => {
  const refresh = vi.fn();
  renderHook(() => useReturnRefresh(refresh));
  show("hidden");
  vi.advanceTimersByTime(RETURN_REFRESH_MS - 1_000);
  show("visible");
  expect(refresh).not.toHaveBeenCalled();
  show("hidden");
  vi.advanceTimersByTime(RETURN_REFRESH_MS);
  show("visible");
  expect(refresh).toHaveBeenCalledOnce();
  show("visible");
  expect(refresh).toHaveBeenCalledOnce();
});
