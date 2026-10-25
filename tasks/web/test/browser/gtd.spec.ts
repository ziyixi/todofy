import { expect, test, type Page } from "@playwright/test";
import {
  addRecord,
  stubPlanning,
  tasksToday,
  type Json,
  type PlanningState,
} from "./planning-stub";

test.use({ serviceWorkers: "block", timezoneId: "America/Los_Angeles" });
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

const reportReads = (state: PlanningState) =>
  state.tasksRequests.filter(
    (request) =>
      request.method === "GET" &&
      request.path.startsWith("/api/tasks/v1/gtdReport?"),
  );

async function reportAfter(page: Page, action: () => Promise<unknown>) {
  const response = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/tasks/v1/gtdReport" &&
      response.request().method() === "GET",
  );
  await action();
  const read = await response;
  expect(read.status()).toBe(200);
  const report = (await read.json()) as Json;
  await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-busy", "false");
  return report;
}

test("GTD tabs keep the chosen month, date and area and reuse its report", async ({
  page,
}) => {
  const state = await stubPlanning(page);
  await reportAfter(page, () => page.goto("/#/gtd"));
  await expect(page.getByRole("tablist", { name: "GTD views" })).toBeVisible();
  const period = page.getByRole("group", { name: "GTD period" });
  await reportAfter(page, () =>
    period.getByRole("button", { name: "Month", exact: true }).click(),
  );
  await reportAfter(page, () =>
    page.getByRole("button", { name: "Previous month" }).click(),
  );
  const selected = await reportAfter(page, () =>
    page.getByRole("combobox", { name: "GTD area" }).selectOption("work"),
  );
  expect(selected.area).toBe("work");
  const dates = page.getByRole("navigation", { name: "GTD date range" });
  const dateLabel = await dates.textContent();
  const reads = reportReads(state).length;
  const requestUrl = new URL(reportReads(state).at(-1)!.path, "http://localhost");
  expect(requestUrl.searchParams.get("start_day")).toBe(selected.start_day);
  expect(requestUrl.searchParams.get("end_day")).toBe(selected.end_day);
  expect(requestUrl.searchParams.get("area")).toBe("work");

  for (const name of ["Completion", "Time", "Overview"]) {
    const tab = page.getByRole("tab", { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(new RegExp(`#/gtd/${name.toLowerCase()}$`, "u"));
    await expect(dates).toHaveText(dateLabel!);
    await expect(period.getByRole("button", { name: "Month" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByRole("combobox", { name: "GTD area" })).toHaveValue(
      "work",
    );
    await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-busy", "false");
    expect(reportReads(state)).toHaveLength(reads);
  }
  expect(
    state.tasksRequests.some((request) =>
      /^\/api\/tasks\/v1\/(?:gtdDays|weeklyReviews)(?:\?|$)/u.test(request.path),
    ),
  ).toBe(false);
});

test("a real Step completion keeps its parent context and recorded time in GTD", async ({
  page,
}, testInfo) => {
  const today = await tasksToday();
  const parent = crypto.randomUUID();
  const completed = crypto.randomUUID();
  const remaining = crypto.randomUUID();
  await stubPlanning(page, {
    tasks: [
      {
        id: parent,
        title: "Synthetic GTD outcome",
        area: "work",
        stage: "committed",
        duration_minutes: 60,
      },
      {
        id: completed,
        title: "Synthetic GTD completed Step",
        kind: "step",
        parent_id: parent,
        duration_minutes: 30,
      },
      {
        id: remaining,
        title: "Synthetic GTD remaining Step",
        kind: "step",
        parent_id: parent,
        duration_minutes: 30,
      },
    ],
    queues: { [today]: [completed, remaining] },
  });
  await addRecord(completed, today, 25, "work");
  await page.setViewportSize({ width: 1489, height: 1056 });
  await page.goto("/#/focus");
  const completion = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `/api/tasks/v1/tasks/${completed}:complete` &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Complete task: Synthetic GTD completed Step" })
    .click();
  expect((await completion).status()).toBe(200);
  await expect(
    page.locator(`.plus-focus-slot[data-task-id="${completed}"]`),
  ).toHaveCount(0);
  const report = await reportAfter(page, () =>
    page.getByRole("link", { name: "GTD", exact: true }).click(),
  );
  expect((report.tasks as Json[]).find((task) => task.task_id === completed)).toEqual(
    expect.objectContaining({
      parent_id: parent,
      parent_title: "Synthetic GTD outcome",
      kind: "step",
      completion_count: 1,
      planned: true,
      completed: true,
      last_completed_day: today,
      recorded_seconds: 1500,
    }),
  );
  expect(Number(report.step_completion_count)).toBeGreaterThanOrEqual(1);
  expect(Number(report.completed_planned_step_count)).toBeGreaterThanOrEqual(1);
  await page.screenshot({
    path: testInfo.outputPath("gtd-overview-1489.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Completion", exact: true }).click();
  const outcome = page.locator(".gtd-progress-details").filter({
    has: page.getByRole("button", { name: "Synthetic GTD outcome", exact: true }),
  });
  await expect(outcome).not.toHaveAttribute("open");
  await expect(outcome.locator("summary")).toContainText("Synthetic GTD outcome");
  const step = outcome.locator(".gtd-step-row").filter({
    has: page.getByRole("button", { name: "Synthetic GTD completed Step" }),
  });
  await expect(step).not.toBeVisible();
  await outcome.locator("summary").click({ position: { x: 8, y: 12 } });
  await expect(outcome).toHaveAttribute("open", "");
  await expect(step).toBeVisible();
  await expect(step).toContainText("Step · Synthetic GTD outcome");
  await expect(step.locator('[aria-label="Completed"]')).toBeVisible();
  await expect(step.locator(".gtd-completed-date")).not.toHaveText("Not completed");
  await page.screenshot({
    path: testInfo.outputPath("gtd-completion-1489.png"),
    fullPage: true,
  });

  await page.getByRole("combobox", { name: "Completion item type" }).selectOption("step");
  const flatStep = page.locator(".gtd-step-row").filter({
    has: page.getByRole("button", { name: "Synthetic GTD completed Step" }),
  });
  await expect(flatStep).toContainText("Step · Synthetic GTD outcome");
  await flatStep.getByRole("button", { name: "Synthetic GTD completed Step" }).click();
  const dialog = page.getByRole("dialog", { name: "Step details", exact: true });
  await expect(dialog.getByRole("textbox", { name: "Task name", exact: true })).toHaveValue(
    "Synthetic GTD completed Step",
  );
  await dialog.getByRole("button", { name: "Close dialog", exact: true }).click();
  await page.getByRole("tab", { name: "Time", exact: true }).click();
  const time = page.locator(".gtd-time-task-row").filter({
    has: page.getByRole("button", { name: "Synthetic GTD outcome", exact: true }),
  });
  await expect(time).toContainText("25m");
  await expect(time).toContainText("1h");
});
