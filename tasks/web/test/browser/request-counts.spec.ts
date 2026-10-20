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
