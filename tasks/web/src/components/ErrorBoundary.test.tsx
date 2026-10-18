import { lazy, Suspense } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("offers a reload when a lazy chunk from an older deploy no longer loads", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const Missing = lazy(() =>
    Promise.reject(
      new TypeError("Failed to fetch dynamically imported module"),
    ),
  );
  render(
    <ErrorBoundary>
      <Suspense fallback={<p>Loading…</p>}>
        <Missing />
      </Suspense>
    </ErrorBoundary>,
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Tasks was updated.",
  );
  expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
});
