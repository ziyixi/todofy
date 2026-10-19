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

it("names a render error generically, and the next route clears it", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  function Page({ broken }: { broken: boolean }) {
    if (broken) throw new Error("Synthetic render failure");
    return <p>Synthetic Focus page</p>;
  }
  const { rerender } = render(
    <ErrorBoundary resetKey="plan">
      <Page broken />
    </ErrorBoundary>,
  );
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("This part of Tasks could not be shown.");
  expect(alert.textContent).not.toContain("Tasks was updated.");
  rerender(
    <ErrorBoundary resetKey="plan">
      <Page broken={false} />
    </ErrorBoundary>,
  );
  expect(screen.getByRole("alert")).toBeTruthy();
  rerender(
    <ErrorBoundary resetKey="focus">
      <Page broken={false} />
    </ErrorBoundary>,
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Synthetic Focus page")).toBeTruthy();
});
