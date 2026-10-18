import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlanningSettings } from "./PlanningSettings";
import { send } from "../api";
vi.mock("../api", async (original) => ({
  ...(await original<typeof import("../api")>()),
  send: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("reads native settings without requiring labels or an extension credential", async () => {
  const transport = vi.mocked(send).mockResolvedValue(
    Response.json({
      plan: {
        enabled: true,
        native_planning: true,
        timezone: "America/Los_Angeles",
      },
    }),
  );
  render(<PlanningSettings />);
  const open = await screen.findByRole("link", { name: "Open Plan" });
  expect(open.getAttribute("href")).toBe("#/plan");
  expect(screen.getByText("Timezone: America/Los_Angeles.")).toBeTruthy();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(
    screen.queryByRole("button", { name: /confirm|save columns/i }),
  ).toBeNull();
  expect(screen.queryByLabelText(/api key|token/i)).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh planning settings" }),
  );
  await screen.findByRole("link", { name: "Open Plan" });
  expect(transport.mock.calls.map(([call]) => call.url)).toEqual([
    "/api/plus/v1/plan:read?view=basic",
    "/api/plus/v1/plan:read?view=basic",
  ]);
});

it("does not claim planning is ready until the native source is activated", async () => {
  vi.mocked(send).mockResolvedValue(
    Response.json({ plan: { timezone: "UTC", enabled: true } }),
  );
  render(<PlanningSettings />);
  await screen.findByText(/Native planning is not ready/);
  expect(screen.queryByRole("link", { name: "Open Plan" })).toBeNull();
});
