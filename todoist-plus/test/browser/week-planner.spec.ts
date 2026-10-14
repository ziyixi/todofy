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
    const readPlanBaseline = await worker.evaluate(
      () =>
        (
          globalThis as unknown as {
            plannerState: { calls: { path: string }[] };
          }
        ).plannerState.calls.filter(
          (call) => call.path === "/api/plus/v1/plan:read",
        ).length,
    );
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
    await expect
      .poll(() =>
        thursday
          .locator(".plus-week-step")
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-task-id")),
          ),
      )
      .toEqual(["second"]);
    await expect(page.locator(".plus-page-header .plus-spin")).toHaveCount(0);
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
    await expect
      .poll(() =>
        thursday
          .locator(".plus-week-step")
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-task-id")),
          ),
      )
      .toEqual(["child", "second"]);
    await expect(page.locator(".plus-page-header .plus-spin")).toHaveCount(0);
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
    await expect
      .poll(() =>
        thursday
          .locator(".plus-week-step")
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-task-id")),
          ),
      )
      .toEqual(["second", "child"]);
    await expect(page.locator(".plus-page-header .plus-spin")).toHaveCount(0);
    expect(
      await worker.evaluate(
        () =>
          (
            globalThis as unknown as {
              plannerState: { calls: { path: string }[] };
            }
          ).plannerState.calls.filter(
            (call) => call.path === "/api/plus/v1/plan:read",
          ).length,
      ),
    ).toBe(readPlanBaseline);
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

test("narrow Plan switches visible days, plans the next week and returns without changing current commitments", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1100, height: 873 });
    await page.goto("https://app.todoist.com/app/today");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    const pool = page.getByRole("complementary", {
      name: "Outcomes and steps",
    });
    await expect(pool.getByText("1 / 5", { exact: true })).toBeVisible();
    await expect(page.locator(".plus-week-day:visible")).toHaveCount(3);
    const bounds = await page
      .locator(".plus-week-planner")
      .evaluate((element) => ({
        overflow: element.scrollWidth > element.clientWidth,
        documentOverflow: document.documentElement.scrollWidth > innerWidth,
        minColumn: Math.min(
          ...[...element.querySelectorAll<HTMLElement>(".plus-week-day")]
            .filter((day) => getComputedStyle(day).display !== "none")
            .map((day) => day.getBoundingClientRect().width),
        ),
      }));
    expect(bounds.overflow).toBe(false);
    expect(bounds.documentOverflow).toBe(false);
    expect(bounds.minColumn).toBeGreaterThan(140);
    const poolBox = await pool.boundingBox();
    const boardBox = await page.locator(".plus-week-planner").boundingBox();
    expect(poolBox).not.toBeNull();
    expect(boardBox).not.toBeNull();
    expect(poolBox!.x + poolBox!.width).toBeLessThan(boardBox!.x);
    expect(
      await pool
        .locator(".plus-family-root > .plus-family-row > .plus-family-title")
        .first()
        .evaluate((element) => element.getBoundingClientRect().width),
    ).toBeGreaterThan(180);
    await page
      .getByRole("tab", { name: "Show 2026-10-18", exact: true })
      .click();
    await expect(
      page.locator('.plus-week-day[data-date="2026-10-18"]'),
    ).toBeVisible();
    await page.getByRole("button", { name: "Next week", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "Show 2026-10-25", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("tab", { name: "Show 2026-10-25", exact: true })
      .click();
    const sunday = page.locator('.plus-week-day[data-date="2026-10-25"]');
    await expect(sunday).toBeVisible();
    await pool
      .getByLabel("Schedule day: Synthetic second step")
      .selectOption("2026-10-25");
    await expect
      .poll(async () => (await plannerDays(worker))["2026-10-25"])
      .toEqual(["second"]);
    await expect(
      sunday.getByText("Synthetic second step", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(
      sunday.getByText("Synthetic second step", { exact: true }),
    ).toBeVisible();
    await expect(pool.getByText("1 / 5", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "This week", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "Show 2026-10-13", exact: true }),
    ).toBeVisible();
    expect((await plannerDays(worker))["2026-10-13"]).toEqual([
      "child",
      "local-one",
    ]);
    await page.setViewportSize({ width: 680, height: 873 });
    await expect(page.locator(".plus-week-day:visible")).toHaveCount(1);
    await page
      .getByRole("tab", { name: "Show 2026-10-18", exact: true })
      .click();
    await expect(
      page.locator('.plus-week-day[data-date="2026-10-18"]'),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
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
  } finally {
    await context.close();
  }
});

test("parent controls and task details stay accessible when only dragging is disabled", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    const pool = page.getByRole("complementary", {
      name: "Outcomes and steps",
    });
    const collapse = pool.getByRole("button", {
      name: "Close: Synthetic weekly outcome",
      exact: true,
    });
    await expect(collapse).toBeEnabled();
    await collapse.click();
    await expect(
      pool.getByRole("button", { name: /^Synthetic first step/u }),
    ).toHaveCount(0);
    await pool
      .getByRole("button", {
        name: "Choose a step: Synthetic weekly outcome",
        exact: true,
      })
      .click();
    await pool.getByRole("button", { name: /^Synthetic first step/u }).click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("heading", { name: "Synthetic first step", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await worker.evaluate(() => {
      (
        globalThis as unknown as {
          plannerState: { timer: Record<string, unknown> };
        }
      ).plannerState.timer = {
        name: "timerSession",
        task_id: "child",
        flow_date: "2026-10-13",
        state: "paused",
        etag: "paused-1",
        saved_seconds: 60,
      };
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Resume", exact: true }),
    ).toBeVisible();
    await expect(
      pool.getByRole("button", {
        name: "Drag to schedule: Synthetic first step",
        exact: true,
      }),
    ).toBeDisabled();
    const title = pool.getByRole("button", { name: /^Synthetic first step/u });
    await expect(title).toBeEnabled();
    await title.click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("heading", { name: "Synthetic first step", exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
