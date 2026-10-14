import { expect, test } from "@playwright/test";
import { dragPlanner, launchPlanner, plannerDays } from "./planner-setup";

test("Focus drag plans a selected day, reorders its blocks and keeps parent context", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    const stack = page.getByRole("list", { name: "Day steps" });
    await expect(stack.getByLabel("Parent task")).toHaveText(
      "Synthetic weekly outcome",
    );
    await expect(
      page.getByRole("button", { name: "Start: Synthetic first step" }),
    ).toBeEnabled();
    await dragPlanner(
      page,
      page.getByRole("button", { name: "Drag step: Synthetic local note" }),
      stack.locator('[data-task-id="child"]'),
    );
    await expect
      .poll(async () => (await plannerDays(worker))["2026-10-13"])
      .toEqual(["local-one", "child"]);
    await expect
      .poll(() =>
        stack
          .locator(".plus-focus-slot")
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-task-id")),
          ),
      )
      .toEqual(["local-one", "child"]);
    await dragPlanner(
      page,
      page.getByRole("button", { name: "Drag step: Synthetic first step" }),
      page.locator('.plus-focus-day[data-date="2026-10-15"]'),
    );
    await expect
      .poll(async () => (await plannerDays(worker))["2026-10-15"])
      .toEqual(["child"]);
    await expect
      .poll(async () => (await plannerDays(worker))["2026-10-13"])
      .toEqual(["local-one"]);
    await page
      .getByRole("button", { name: "Thu 2026-10-15", exact: true })
      .click();
    await expect(
      stack.getByText("Synthetic first step", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start: Synthetic first step" }),
    ).toBeDisabled();
    await expect(page.locator(".plus-focus-timing-note")).toContainText(
      "Switch to today to start timing.",
    );
    await expect(
      stack.getByText("Synthetic local note", { exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Choose tasks", exact: true })
      .click();
    await dragPlanner(
      page,
      page.getByRole("button", { name: "Drag step: Synthetic second step" }),
      stack.locator('[data-task-id="child"]'),
    );
    await expect
      .poll(async () => (await plannerDays(worker))["2026-10-15"])
      .toEqual(["second", "child"]);
    const moveUp = page.getByRole("button", {
      name: "Move up: Synthetic first step",
    });
    await expect(moveUp).toBeEnabled();
    await moveUp.focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await plannerDays(worker))["2026-10-15"])
      .toEqual(["child", "second"]);
    await expect
      .poll(() =>
        stack
          .locator(".plus-focus-slot")
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-task-id")),
          ),
      )
      .toEqual(["child", "second"]);
    await page.reload();
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    await page
      .getByRole("button", { name: "Thu 2026-10-15", exact: true })
      .click();
    await expect(stack.locator(".plus-focus-slot")).toHaveCount(2);
    expect(
      await stack
        .locator(".plus-focus-slot")
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-task-id")),
        ),
    ).toEqual(["child", "second"]);
  } finally {
    await context.close();
  }
});

test("changing the Focus day preserves the current timer and prevents starting a second task", async () => {
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
      state.days["2026-10-15"] = ["second"];
      state.timer = {
        name: "timerSession",
        task_id: "child",
        flow_date: "2026-10-13",
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
      page.getByRole("button", { name: "Pause: Synthetic first step" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Drag step: Synthetic first step" }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Thu 2026-10-15", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Start: Synthetic second step" }),
    ).toBeDisabled();
    await expect(page.locator(".plus-timer-bar")).toContainText(
      "Synthetic first step",
    );
    const after = await worker.evaluate(
      () =>
        (
          globalThis as unknown as {
            plannerState: { timer: Record<string, unknown> };
          }
        ).plannerState.timer,
    );
    expect(after).toEqual(before);
  } finally {
    await context.close();
  }
});
