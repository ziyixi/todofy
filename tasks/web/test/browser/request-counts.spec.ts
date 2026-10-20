import { expect, test, type Page } from "@playwright/test";
import {
  createTask,
  stubPlanning,
  type Json,
  type PlanningState,
} from "./planning-stub";

// How many requests an interaction sends. Each count waits until the page has been idle for 500ms.
test.use({ serviceWorkers: "block", timezoneId: "America/Los_Angeles" });

const today = "2026-10-13";
const planReads = (state: PlanningState) =>
  state.requests.filter((request) => request.path === "/api/plus/v1/plan:read")
    .length;
async function settled(page: Page) {
  await page.waitForLoadState("networkidle");
}
function outcome(id: string, title: string): Json {
  return {
    id,
    kind: "task",
    title,
    area: "work",
    stage: "committed",
    explicit_stage: "committed",
    planning_flags: [],
    etag: "1",
  };
}

test("completing a card in Plan reads Plan once, and moving between Plan and Focus reads nothing", async ({
  page,
  request,
}) => {
  const task = await createTask(request, {
    title: "Synthetic counted outcome",
  });
  const state = await stubPlanning(
    page,
    { today, tasks: [outcome(task.id, task.title)] },
    request,
  );
  await page.clock.setFixedTime(new Date(`${today}T18:00:00Z`));
  await page.goto("/#/plan");
  const committed = page.getByRole("region", {
    name: "Committed",
    exact: true,
  });
  await expect(
    committed.locator(`[data-outcome-id="${task.id}"]`),
  ).toBeVisible();
  await settled(page);
  expect(planReads(state)).toBe(1);
  await page.getByRole("link", { name: "Focus", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Focus", level: 1 }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Plan", exact: true }).click();
  await expect(committed).toBeVisible();
  await settled(page);
  expect(planReads(state)).toBe(1);
  await committed
    .getByRole("button", {
      name: `Complete task: ${task.title}`,
      exact: true,
    })
    .click();
  await expect(committed.locator(`[data-outcome-id="${task.id}"]`)).toHaveCount(
    0,
  );
  await settled(page);
  // Plan reads its own write back; the host's refresh after a write is only for the writes made elsewhere.
  expect(planReads(state)).toBe(2);
});

test("opening a task reads it once, and its children only when it has some", async ({
  page,
  request,
}) => {
  const suffix = crypto.randomUUID();
  const single = await createTask(request, {
    title: `Synthetic childless ${suffix}`,
  });
  const parent = await createTask(request, {
    title: `Synthetic parent ${suffix}`,
  });
  await createTask(request, {
    title: `Synthetic child ${suffix}`,
    parent_id: parent.id,
  });
  await stubPlanning(page, {
    tasks: [single, parent].map((task) => ({
      ...outcome(task.id, task.title),
      ...{ stage: "none", explicit_stage: "none" },
    })),
  });
  const reads: string[] = [];
  page.on("request", (event) => {
    const url = new URL(event.url());
    const parentId = url.searchParams.get("parent_id");
    if (event.method() !== "GET") return;
    if (url.pathname.startsWith("/api/tasks/v1/tasks/"))
      reads.push(`get ${url.pathname.slice("/api/tasks/v1/tasks/".length)}`);
    else if (url.pathname === "/api/tasks/v1/tasks" && parentId)
      reads.push(`children ${parentId}`);
  });
  await page.goto("/#/inbox");
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await page.getByText(single.title, { exact: true }).click();
  await expect(dialog).toBeVisible();
  await settled(page);
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page.getByText(parent.title, { exact: true }).click();
  await expect(
    dialog.getByRole("button", {
      name: `Synthetic child ${suffix}`,
      exact: true,
    }),
  ).toBeVisible();
  await settled(page);
  expect(reads).toEqual([
    `get ${single.id}`,
    `get ${parent.id}`,
    `children ${parent.id}`,
  ]);
});
