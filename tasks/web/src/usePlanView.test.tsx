import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_PLAN_VIEW } from "@ziyixi/planning-ui/plan-view-state";
import { usePlanView } from "./usePlanView";

// Node 26 has its own localStorage global; use the test browser's real Storage.
const browserStorage = (globalThis as typeof globalThis & {
  jsdom: { window: Window };
}).jsdom.window.localStorage;

beforeEach(() => vi.stubGlobal("localStorage", browserStorage));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

it("keeps Week selection, commitment, folding and review checks across leaving and reopening Plan", () => {
  const first = renderHook(usePlanView);
  act(() => {
    first.result.current[1]({ tab: "week", commitment: "synthetic-commitment", committedFolded: true });
    first.result.current[1]({ review: { week: "2026-10-19", open: true, lines: [1, 3], kept: ["synthetic-kept"] } });
  });
  first.unmount();
  const reopened = renderHook(usePlanView);
  expect(reopened.result.current[0]).toEqual({
    ...DEFAULT_PLAN_VIEW,
    tab: "week",
    commitment: "synthetic-commitment",
    committedFolded: true,
    review: { week: "2026-10-19", open: true, lines: [1, 3], kept: ["synthetic-kept"] },
  });
  act(() => {
    reopened.result.current[1]({ tab: "review" });
  });
  expect(reopened.result.current[0].review.lines).toEqual([1, 3]);
});

it("ignores malformed or unrelated stored data instead of treating it as planning state", () => {
  window.localStorage.setItem("tasks.plan-view", JSON.stringify({ ...DEFAULT_PLAN_VIEW, taskTitle: "Do not load content" }));
  const invalidShape = renderHook(usePlanView);
  expect(invalidShape.result.current[0]).toEqual(DEFAULT_PLAN_VIEW);
  invalidShape.unmount();
  window.localStorage.setItem("tasks.plan-view", "not valid JSON");
  expect(renderHook(usePlanView).result.current[0]).toEqual(DEFAULT_PLAN_VIEW);
});

it("keeps planning usable in memory when browser storage is unavailable", () => {
  vi.spyOn(window.Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
  vi.spyOn(window.Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
  const { result } = renderHook(usePlanView);
  expect(result.current[0].tab).toBe("review");
  act(() => result.current[1]({ tab: "week" }));
  expect(result.current[0].tab).toBe("week");
});
