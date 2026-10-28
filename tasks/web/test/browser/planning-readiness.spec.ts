import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  addDays,
  readFocus,
  stubPlanning,
  tasksToday,
  type SeedTask,
} from "./planning-stub";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });

async function drag(page: Page, source: Locator, target: Locator) {
  await source.scrollIntoViewIfNeeded();
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + 45, from.y + 25);
  await page.mouse.down();
  await page.mouse.move(from.x + 55, from.y + 25, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + 40, { steps: 18 });
  await page.mouse.up();
}

test("completed prerequisites and deadline windows surface in Parked, and planning acknowledges them", async ({
  page,
  request,
}, testInfo) => {
  const today = await tasksToday();
  const deadline = addDays(today, 3);
  const manual: SeedTask[] = Array.from({ length: 5 }, (_, n) => ({
    id: `readiness-manual-${n}`,
    title: `Synthetic parked backlog ${n}`,
    planning_flags: ["parked"],
  }));
  await stubPlanning(page, {
    tasks: [
      ...manual,
      { id: "readiness-before", title: "Synthetic prerequisite" },
      {
        id: "readiness-waiting",
        title: "Synthetic waiting outcome",
        stage: "committed",
        planning_flags: ["waiting"],
      },
      {
        id: "readiness-waiting-step",
        title: "Synthetic waiting action",
        kind: "step",
        parent_id: "readiness-waiting",
        duration_minutes: 20,
      },
      {
        id: "readiness-after",
        title: "Synthetic unlocked outcome",
        stage: "monthly",
        area: "work",
        due_date: addDays(today, 8),
        dependencies: ["readiness-before"],
      },
      {
        id: "readiness-window",
        title: "Synthetic deadline outcome",
        stage: "quarterly",
        area: "work",
        deadline,
        lead_days: 3,
      },
    ],
    queues: { [today]: ["readiness-waiting-step"] },
  });
  const queue = await readFocus(today, addDays(today, 6));
  await page.goto("/#/plan");
  const parked = page.getByRole("region", { name: "Parked", exact: true });
  await expect(
    parked.locator('[data-outcome-id="readiness-window"]'),
  ).toBeVisible();
  await expect(
    parked.locator('[data-outcome-id="readiness-after"]'),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Waiting", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator('[data-outcome-id="readiness-waiting"]'),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Week", exact: true }).click();
  await expect(
    page.getByText("Synthetic waiting action", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  const before = await (
    await request.get("/api/tasks/v1/tasks/readiness-before")
  ).json();
  const { token } = await (await request.get("/api/tasks/csrf")).json();
  const response = await request.post(
    "/api/tasks/v1/tasks/readiness-before:complete",
    {
      headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
      data: { etag: before.etag, request_id: crypto.randomUUID() },
    },
  );
  expect(response.status(), await response.text()).toBe(200);
  await page.reload();
  const ready = parked.locator('[data-outcome-id="readiness-after"]');
  await expect(ready).toBeVisible();
  await expect(ready).toContainText("Prerequisites completed");
  await expect(parked.locator(".planning-outcome-card")).toHaveCount(5); // Two ready plus three manual.
  await page.screenshot({ path: testInfo.outputPath("parked-ready.png") });
  const savedBefore = await (
    await request.get("/api/tasks/v1/tasks/readiness-after")
  ).json();
  expect(savedBefore.stage).toBe("monthly");
  await drag(
    page,
    ready,
    page.getByRole("region", { name: "Committed", exact: true }),
  );
  await expect(
    page
      .getByRole("region", { name: "Committed", exact: true })
      .locator('[data-outcome-id="readiness-after"]'),
  ).toBeVisible();
  await expect(page.locator(".review-draggable.is-pending")).toHaveCount(0);
  await page.reload();
  await expect(
    parked.locator('[data-outcome-id="readiness-after"]'),
  ).toHaveCount(0);
  const saved = await (
    await request.get("/api/tasks/v1/tasks/readiness-after")
  ).json();
  expect(saved.planning_flags).toContain("active");
  expect(saved.due_date).toBe(savedBefore.due_date);
  expect(saved.dependencies).toEqual(savedBefore.dependencies);
  expect(await readFocus(today, addDays(today, 6))).toEqual(queue);
  await page.goto("/#/focus");
  await expect(
    page.getByText("Synthetic waiting action", { exact: true }),
  ).toBeVisible();
  const hint = page.getByRole("button", {
    name: "1 in its start window, not planned this week",
  });
  await expect(hint).toBeVisible();
  await hint.click();
  await expect(parked).toBeFocused();
});

test("Dependents are read-only, arrive with task details, and their links use Save return navigation", async ({
  page,
}) => {
  const state = await stubPlanning(page, {
    tasks: [
      { id: "reverse-before", title: "Synthetic reverse prerequisite" },
      {
        id: "reverse-after",
        title: "Synthetic reverse dependent",
        dependencies: ["reverse-before"],
      },
    ],
  });
  await page.goto("/?task=reverse-before#/inbox");
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  const section = dialog.getByLabel("Dependent tasks", { exact: true });
  await expect(
    section.getByRole("heading", { name: "Dependents" }),
  ).toBeVisible();
  await expect(
    section.getByRole("button", {
      name: "Synthetic reverse dependent",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    section.getByRole("button", { name: /Remove|Add/u }),
  ).toHaveCount(0);
  expect(state.tasksRequests.filter((call) => call.method !== "GET")).toEqual(
    [],
  );
  expect(
    state.tasksRequests.filter((call) => call.path.includes("dependents")),
  ).toEqual([]);
  await section
    .getByRole("button", { name: "Synthetic reverse dependent", exact: true })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Task name", exact: true }),
  ).toHaveValue("Synthetic reverse dependent");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Task name", exact: true }),
  ).toHaveValue("Synthetic reverse prerequisite");
  await expect(
    section.getByRole("button", {
      name: "Synthetic reverse dependent",
      exact: true,
    }),
  ).toBeVisible();
});

test("a saved Waiting flag clears from task details, and the task returns to Plan", async ({
  page,
  request,
}) => {
  await stubPlanning(page, {
    tasks: [
      {
        id: "leave-waiting",
        title: "Synthetic held outcome",
        stage: "monthly",
        planning_flags: ["waiting", "onhold"],
      },
    ],
  });
  await page.goto("/#/plan");
  const month = page.getByRole("region", { name: "Month", exact: true });
  await expect(month).toBeVisible();
  await expect(page.locator('[data-outcome-id="leave-waiting"]')).toHaveCount(
    0,
  );
  await page.goto("/?task=leave-waiting#/plan");
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await dialog
    .getByRole("button", { name: "Clear Waiting", exact: true })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Clear Waiting", exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Clear On hold", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const saved = await (
    await request.get("/api/tasks/v1/tasks/leave-waiting")
  ).json();
  expect(saved.planning_flags).toEqual(["onhold"]);
  expect(saved.stage).toBe("monthly");
  await page.reload();
  await expect(
    month.locator('[data-outcome-id="leave-waiting"]'),
  ).toBeVisible();
});
