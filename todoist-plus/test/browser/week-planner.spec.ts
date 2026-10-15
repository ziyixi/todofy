import {
  expect,
  test,
  type Locator,
  type Page,
  type Worker,
} from "@playwright/test";
import { dragPlanner, launchPlanner, plannerDays } from "./planner-setup";
async function openWeek(page: Page) {
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await page.getByRole("tab", { name: "Week", exact: true }).click();
}
async function readPlanCount(worker: Worker) {
  return worker.evaluate(
    () =>
      (
        globalThis as unknown as { plannerState: { calls: { path: string }[] } }
      ).plannerState.calls.filter(
        (call) => call.path === "/api/plus/v1/plan:read",
      ).length,
  );
}
async function flowReads(worker: Worker) {
  return worker.evaluate(
    () =>
      (
        globalThis as unknown as {
          plannerState: { calls: { path: string; method: string }[] };
        }
      ).plannerState.calls.filter(
        (call) => call.method === "GET" && call.path.includes("/flows/"),
      ).length,
  );
}
async function cardIds(day: Locator) {
  return day
    .locator(".planning-calendar-step")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-task-id")),
    );
}

test("Review moves an explicit outcome between mapped stages using its identity and etag", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    const quarter = page.getByRole("region", { name: "Quarter", exact: true });
    const month = page.getByRole("region", { name: "Month", exact: true });
    await expect(quarter.locator('[data-outcome-id="quarter"]')).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Week", exact: true })
        .locator('[data-outcome-id="candidate"]'),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Committed", exact: true })
        .locator('[data-outcome-id="parent"]'),
    ).toBeVisible();
    const baseline = await readPlanCount(worker);
    await dragPlanner(
      page,
      quarter.getByRole("button", {
        name: "Move outcome: Synthetic quarter outcome",
      }),
      month,
    );
    await expect(month.locator('[data-outcome-id="quarter"]')).toBeVisible();
    await expect(quarter.locator('[data-outcome-id="quarter"]')).toHaveCount(0);
    await expect(page.locator(".plus-page-header .plus-spin")).toHaveCount(0);
    const state = await worker.evaluate(
      () =>
        (
          globalThis as unknown as {
            plannerState: {
              tasks: Record<string, unknown>[];
              calls: { path: string; body: Record<string, unknown> }[];
            };
          }
        ).plannerState,
    );
    const moved = state.tasks.find((task) => task.id === "quarter")!;
    expect(moved.stage).toBe("monthly");
    expect(moved.labels).toEqual(["office", "context", "candiate"]);
    const request = state.calls.find((call) =>
      call.path.endsWith("/tasks:setTaskPlan"),
    )!.body;
    expect(request).toMatchObject({
      task_id: "quarter",
      etag: "quarter-1",
      stage: "monthly",
    });
    expect(request.request_id).toMatch(/^[a-f0-9-]{36}$/u);
    expect(request).not.toHaveProperty("due");
    expect(request).not.toHaveProperty("deadline");
    expect(request).not.toHaveProperty("bet");
    expect(await readPlanCount(worker)).toBe(baseline);
  } finally {
    await context.close();
  }
});

test("real pointer scheduling uses leaf steps and persists day moves without full task reloads", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await openWeek(page);
    const tray = page.getByRole("region", {
      name: "Next steps: Synthetic weekly outcome",
    });
    await expect(
      tray.getByRole("button", { name: /^Synthetic first step/u }),
    ).toBeVisible();
    await expect(
      page.locator(".planning-commitment-grid [data-outcome-id]"),
    ).toHaveCount(1);
    const baseline = await readPlanCount(worker);
    const flowBaseline = await flowReads(worker);
    const layout = await page
      .locator(".planning-calendar")
      .evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        overflow: element.scrollWidth > element.clientWidth,
        columns: [...element.querySelectorAll(".planning-calendar-day")].map(
          (day) => day.getBoundingClientRect().width,
        ),
      }));
    expect(layout.width).toBeGreaterThan(1200);
    expect(layout.columns).toHaveLength(7);
    expect(layout.columns.every((width) => width >= 130)).toBe(true);
    expect(layout.overflow).toBe(false);
    const thursday = page.locator(
      '.planning-calendar-day[data-date="2026-10-15"]',
    );
    const tuesday = page.locator(
      '.planning-calendar-day[data-date="2026-10-13"]',
    );
    await dragPlanner(
      page,
      tray.getByRole("button", { name: "Drag step: Synthetic second step" }),
      thursday.locator(".planning-day-end"),
    );
    await expect.poll(() => cardIds(thursday)).toEqual(["second"]);
    await expect(page.locator(".plus-page-header .plus-spin")).toHaveCount(0);
    await expect(
      thursday.locator(".planning-calendar-step-meta > span"),
    ).toHaveText("Synthetic weekly outcome");

    await dragPlanner(
      page,
      tuesday.getByRole("button", {
        name: "Drag scheduled step: Synthetic first step",
      }),
      thursday.locator('[data-task-id="second"]'),
    );
    await expect.poll(() => cardIds(thursday)).toEqual(["child", "second"]);
    await expect
      .poll(async () => (await plannerDays(worker))["2026-10-13"])
      .toEqual(["local-one"]);
    await expect(page.locator(".plus-page-header .plus-spin")).toHaveCount(0);
    await dragPlanner(
      page,
      thursday.getByRole("button", {
        name: "Drag scheduled step: Synthetic second step",
      }),
      thursday.locator('[data-task-id="child"]'),
    );
    await expect.poll(() => cardIds(thursday)).toEqual(["second", "child"]);
    await expect(page.locator(".plus-page-header .plus-spin")).toHaveCount(0);
    expect(await readPlanCount(worker)).toBe(baseline);
    // Only the tray drop and the same-day reorder read their one target day; the confirmed
    // queues are shown without reading the whole week again.
    expect((await flowReads(worker)) - flowBaseline).toBe(2);
    await page.reload();
    await openWeek(page);
    await expect.poll(() => cardIds(thursday)).toEqual(["second", "child"]);
    const writes = await worker.evaluate(() =>
      (
        globalThis as unknown as {
          plannerState: {
            calls: {
              path: string;
              method: string;
              body: Record<string, unknown>;
            }[];
          };
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
    expect(
      writes.every(
        (call) => !("due" in call.body) && !("deadline" in call.body),
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test("narrow Week remains full width and plans another week without relabelling current commitments", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1100, height: 873 });
    await page.goto("https://app.todoist.com/app/today");
    await openWeek(page);
    await expect(page.locator(".planning-calendar-day:visible")).toHaveCount(3);
    const bounds = await page
      .locator(".planning-calendar")
      .evaluate((element) => ({
        overflow: element.scrollWidth > element.clientWidth,
        documentOverflow: document.documentElement.scrollWidth > innerWidth,
        minColumn: Math.min(
          ...[
            ...element.querySelectorAll<HTMLElement>(".planning-calendar-day"),
          ]
            .filter((day) => getComputedStyle(day).display !== "none")
            .map((day) => day.getBoundingClientRect().width),
        ),
      }));
    expect(bounds.overflow).toBe(false);
    expect(bounds.documentOverflow).toBe(false);
    expect(bounds.minColumn).toBeGreaterThan(140);
    await page
      .getByRole("tab", { name: "Show 2026-10-18", exact: true })
      .click();
    await expect(
      page.locator('.planning-calendar-day[data-date="2026-10-18"]'),
    ).toBeVisible();
    await page.getByRole("button", { name: "Next week", exact: true }).click();
    await page
      .getByRole("tab", { name: "Show 2026-10-25", exact: true })
      .click();
    const sunday = page.locator(
      '.planning-calendar-day[data-date="2026-10-25"]',
    );
    const tray = page.getByRole("region", {
      name: "Next steps: Synthetic weekly outcome",
    });
    await dragPlanner(
      page,
      tray.getByRole("button", { name: "Drag step: Synthetic second step" }),
      sunday.locator(".planning-day-end"),
    );
    await expect.poll(() => cardIds(sunday)).toEqual(["second"]);
    await expect(page.locator(".plus-page-header .plus-spin")).toHaveCount(0);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => cardIds(sunday)).toEqual(["second"]);
    await page.getByRole("button", { name: "This week", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "Show 2026-10-13", exact: true }),
    ).toBeVisible();
    expect((await plannerDays(worker))["2026-10-13"]).toEqual([
      "child",
      "local-one",
    ]);
    await page.setViewportSize({ width: 680, height: 873 });
    await expect(page.locator(".planning-calendar-day:visible")).toHaveCount(1);
    await page
      .getByRole("tab", { name: "Show 2026-10-18", exact: true })
      .click();
    await expect(
      page.locator('.planning-calendar-day[data-date="2026-10-18"]'),
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
    expect(
      writes.every((call) =>
        call.path.startsWith("/api/plus/flowday/api/v1/flows/"),
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test("outcome selection and child details stay accessible while a timed step cannot move", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await openWeek(page);
    const outcome = page
      .locator(".planning-commitment-grid")
      .getByRole("button", { name: /^Synthetic weekly outcome/u });
    await expect(outcome).toBeEnabled();
    await outcome.click();
    await expect(
      page.getByRole("region", {
        name: "Next steps: Synthetic weekly outcome",
      }),
    ).toHaveCount(0);
    await outcome.click();
    const tray = page.getByRole("region", {
      name: "Next steps: Synthetic weekly outcome",
    });
    await tray.getByRole("button", { name: /^Synthetic first step/u }).click();
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
      tray.getByRole("button", {
        name: "Drag step: Synthetic first step",
        exact: true,
      }),
    ).toBeDisabled();
    const title = tray.getByRole("button", { name: /^Synthetic first step/u });
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
