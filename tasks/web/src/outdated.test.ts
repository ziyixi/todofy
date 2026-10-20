import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { BUILD_HEADER, UNKNOWN_ROUTE } from "../../shared/build";

// The unit tests' bundle is "unit-test-build" (vite.config.ts). Each test starts from a fresh, current tab.
let outdated: typeof import("./outdated");
beforeEach(async () => {
  vi.resetModules();
  outdated = await import("./outdated");
});
function answer(status: number, build?: string, message = "") {
  return new Response(JSON.stringify(message ? { error: { message } } : {}), {
    status,
    headers: build ? { [BUILD_HEADER]: build } : {},
  });
}

it("marks the tab outdated when an answer comes from another build, and tells the app", async () => {
  const { result } = renderHook(() => outdated.useOutdated());
  await outdated.checkBuild(answer(200, "unit-test-build"));
  await outdated.checkBuild(
    answer(404, "unit-test-build", "Resource does not exist"),
  );
  expect(result.current).toBe(false);
  await act(() => outdated.checkBuild(answer(200, "newer-build")));
  expect(result.current).toBe(true);
  expect(outdated.isOutdated()).toBe(true);
});

it("takes an unknown route for an update only when an answer names no build", async () => {
  // The same build answering an unknown route is a bug in this bundle, which a reload would not fix.
  await outdated.checkBuild(answer(404, "unit-test-build", UNKNOWN_ROUTE));
  await outdated.checkBuild(answer(404, undefined, "Resource does not exist"));
  await outdated.checkBuild(answer(200));
  expect(outdated.isOutdated()).toBe(false);
  await outdated.checkBuild(answer(404, undefined, UNKNOWN_ROUTE));
  expect(outdated.isOutdated()).toBe(true);
});

it("takes a method its path does not take for an update", async () => {
  await outdated.checkBuild(answer(405));
  expect(outdated.isOutdated()).toBe(true);
});
