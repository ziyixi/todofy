import { expect, test } from "@playwright/test";
import { dragPlanner, launchPlanner, plannerDays } from "./planner-setup";

test("steps arranged in Plan appear directly in today's execution-only Focus", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    const today = page.locator('.plus-week-day[data-date="2026-10-13"]');
    await dragPlanner(
      page,
      page
        .getByRole("complementary", { name: "Outcomes and steps" })
        .getByRole("button", {
          name: "Drag to schedule: Synthetic second step",
        }),
      today.locator(".plus-week-day-end"),
    );
    await expect
      .poll(async () => (await plannerDays(worker))["2026-10-13"])
      .toEqual(["child", "local-one", "second"]);
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    const stack = page.getByRole("list", { name: "Today's steps" });
    await expect
      .poll(() =>
        stack
          .locator(".plus-focus-slot")
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-task-id")),
          ),
      )
      .toEqual(["child", "local-one", "second"]);
    await expect(stack.getByLabel("Parent task")).toHaveCount(2);
    await expect(stack.getByLabel("Parent task").first()).toHaveText(
      "Synthetic weekly outcome",
    );
    await expect(
      stack.getByText("Synthetic local note", { exact: true }),
    ).toBeVisible();
    await expect(stack.getByText("30m", { exact: true })).toBeVisible();
    await expect(stack.getByText("1h", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /Choose tasks|Drag step|Remove from day|Move up|Move down/,
      }),
    ).toHaveCount(0);
    await expect(stack.getByRole("combobox")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Start: Synthetic first step" }),
    ).toBeEnabled();
    const fontSizes = await stack
      .locator('[data-task-id="child"]')
      .evaluate((slot) => ({
        title: getComputedStyle(slot.querySelector(".plus-focus-title")!)
          .fontSize,
        parent: getComputedStyle(slot.querySelector(".plus-task-breadcrumb")!)
          .fontSize,
        estimate: getComputedStyle(slot.querySelector(".plus-focus-estimate")!)
          .fontSize,
      }));
    expect(fontSizes).toEqual({
      title: "14px",
      parent: "12px",
      estimate: "12px",
    });
    await page
      .getByRole("button", { name: "Adjust plan", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Plan", exact: true }),
    ).toBeVisible();
    expect((await plannerDays(worker))["2026-10-13"]).toEqual([
      "child",
      "local-one",
      "second",
    ]);
  } finally {
    await context.close();
  }
});

test("today's Focus preserves an older timer without treating the same task as today's active session", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const before = await worker.evaluate(() => {
      const state = (
        globalThis as unknown as {
          plannerState: {
            days: Record<string, string[]>;
            timer: Record<string, unknown>;
          };
        }
      ).plannerState;
      state.days["2026-10-12"] = ["child"];
      state.timer = {
        name: "timerSession",
        task_id: "child",
        flow_date: "2026-10-12",
        state: "running",
        etag: "7",
        saved_seconds: 75,
        segment_start_time: new Date().toISOString(),
      };
      return state.timer;
    });
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    await expect(
      page.getByRole("list", { name: "Today's steps" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start: Synthetic first step" }),
    ).toBeDisabled();
    await expect(page.locator(".plus-focus-block.is-current")).toHaveCount(0);
    await expect(page.locator(".plus-timer-bar")).toContainText(
      "Synthetic first step",
    );
    await page
      .getByRole("button", { name: "Adjust plan", exact: true })
      .click();
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    await expect(
      page.getByRole("list", { name: "Today's steps" }),
    ).toBeVisible();
    const after = await worker.evaluate(
      () =>
        (
          globalThis as unknown as {
            plannerState: { timer: Record<string, unknown> };
          }
        ).plannerState.timer,
    );
    expect(after).toEqual(before);
    expect((await plannerDays(worker))["2026-10-12"]).toEqual(["child"]);
  } finally {
    await context.close();
  }
});
