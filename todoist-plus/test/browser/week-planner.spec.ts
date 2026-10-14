import { expect, test } from "@playwright/test";
import { dragPlanner, launchPlanner, plannerDays } from "./planner-setup";

test("real pointer dragging schedules a child, moves days and reorders without changing Todoist dates", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    const pool = page.getByRole("complementary", {
      name: "Outcomes and steps",
    });
    await expect(
      pool.getByText("Synthetic first step", { exact: true }),
    ).toBeVisible();
    await expect(pool.getByText("1 / 5", { exact: true })).toBeVisible();
    const layout = await page.locator(".plus-root-plan").evaluate((root) => ({
      rootWidth: root.getBoundingClientRect().width,
      columnWidths: [...root.querySelectorAll(".plus-week-day")].map(
        (day) => day.getBoundingClientRect().width,
      ),
      overflowing: root.scrollWidth > root.clientWidth,
    }));
    expect(layout.rootWidth).toBeGreaterThan(1200);
    expect(layout.columnWidths).toHaveLength(7);
    expect(layout.columnWidths.every((width) => width >= 130)).toBe(true);
    expect(layout.overflowing).toBe(false);
    const thursday = page.locator('.plus-week-day[data-date="2026-10-15"]');
    await dragPlanner(
      page,
      pool.getByRole("button", {
        name: "Drag to schedule: Synthetic second step",
      }),
      thursday.locator(".plus-week-day-end"),
    );
    await expect
      .poll(async () => (await plannerDays(worker))["2026-10-15"])
      .toEqual(["second"]);
    await expect(thursday.getByLabel("Parent task")).toHaveText(
      "Synthetic weekly outcome",
    );
    await expect(thursday.locator(".plus-week-day-heading small")).toHaveText(
      "1h",
    );
    const tuesday = page.locator('.plus-week-day[data-date="2026-10-13"]');
    await dragPlanner(
      page,
      tuesday.getByRole("button", {
        name: "Drag to schedule: Synthetic first step",
      }),
      thursday.locator('[data-task-id="second"]'),
    );
    await expect
      .poll(async () => (await plannerDays(worker))["2026-10-15"])
      .toEqual(["child", "second"]);
    await expect
      .poll(async () => (await plannerDays(worker))["2026-10-13"])
      .toEqual(["local-one"]);
    await dragPlanner(
      page,
      thursday.getByRole("button", {
        name: "Drag to schedule: Synthetic second step",
      }),
      thursday.locator('[data-task-id="child"]'),
    );
    await expect
      .poll(async () => (await plannerDays(worker))["2026-10-15"])
      .toEqual(["second", "child"]);
    await page.reload();
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await expect
      .poll(async () =>
        thursday
          .locator(".plus-week-step")
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-task-id")),
          ),
      )
      .toEqual(["second", "child"]);
    const writes = await worker.evaluate(() =>
      (
        globalThis as unknown as {
          plannerState: { calls: { path: string; method: string }[] };
        }
      ).plannerState.calls.filter((call) => call.method !== "GET"),
    );
    expect(writes.length).toBeGreaterThan(0);
    expect(
      writes.every((call) =>
        call.path.startsWith("/api/plus/flowday/api/v1/flows/"),
      ),
    ).toBe(true);
    expect(
      writes.filter((call) => call.path.endsWith(":rollover")),
    ).toHaveLength(1);
  } finally {
    await context.close();
  }
});
