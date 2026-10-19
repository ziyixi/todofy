import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createTask,
  flowdayTaskWrites,
  stubPlanning,
  type Json,
  type PlanningState,
} from "./planning-stub";

test.use({ serviceWorkers: "block", timezoneId: "America/Los_Angeles" });

const outcome = (id: string, title: string, fields: Json = {}): Json => ({
  id,
  kind: "task",
  title,
  area: "work",
  stage: "committed",
  explicit_stage: "committed",
  planning_flags: [],
  etag: "1",
  ...fields,
});
const step = (id: string, title: string, parent: string): Json => ({
  id,
  kind: "step",
  title,
  parent_id: parent,
  area: "unassigned",
  stage: "none",
  explicit_stage: "none",
  planning_flags: [],
  etag: "1",
});
const bodies = (state: PlanningState, path: string) =>
  state.requests
    .filter((request) => request.path === path)
    .map((request) => request.body);

async function openPlan(page: Page, path = "/#/plan") {
  await page.clock.setFixedTime(new Date("2026-10-13T18:00:00Z"));
  await page.goto(path);
  await expect(
    page.getByRole("region", { name: "Weekly goals" }),
  ).toBeVisible();
}
/** Opens Plan's details for a Review card. */
async function details(page: Page, title: string) {
  await page
    .getByRole("button", { name: new RegExp(`^${title},`, "u") })
    .first()
    .click();
  return page.locator("dialog.plus-dialog[open]");
}
async function drag(page: Page, handle: Locator, target: Locator) {
  // The previous drop has settled and its overlay is gone.
  await expect(
    page.locator("[data-dnd-overlay][data-dnd-dragging]"),
  ).toHaveCount(0);
  await expect(handle).toBeEnabled();
  await expect(target).toBeVisible();
  const source = (await handle.boundingBox())!;
  const end = (await target.boundingBox())!;
  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    source.x + source.width / 2 + 8,
    source.y + source.height / 2,
    { steps: 3 },
  );
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, {
    steps: 18,
  });
  await page.mouse.up();
}

test("a weekly Bet is edited in place and saved once over its etag", async ({
  page,
}) => {
  const state = await stubPlanning(page, {
    tasks: [outcome("launch", "Synthetic launch")],
    bets: [
      {
        week_start: "2026-10-12",
        area: "work",
        text: "Synthetic work line",
        etag: "2",
      },
    ],
  });
  await openPlan(page);
  const goals = page.getByRole("region", { name: "Weekly goals" });
  await goals
    .getByRole("button", { name: "Edit work goal: Synthetic work line" })
    .click();
  const input = goals.getByRole("textbox", { name: "This week's work goal" });
  await expect(input).toBeFocused();
  await page.keyboard.type(" for review");
  await page.keyboard.press("Enter");
  await expect(
    goals.getByRole("button", {
      name: "Edit work goal: Synthetic work line for review",
    }),
  ).toBeFocused();
  expect(bodies(state, "/api/plus/v1/weeklyBets:setWeeklyBet")).toEqual([
    {
      week_start: "2026-10-12",
      area: "work",
      text: "Synthetic work line for review",
      etag: "2",
    },
  ]);
});

test("a dependency is added in the details, and completing its prerequisite in Focus settles it", async ({
  page,
  request,
}) => {
  // Focus completes the step in Tasks' own D1 before it settles FlowDay through Todofy.
  const { id: venue } = await createTask(request, {
    title: "Synthetic venue booking",
  });
  const { id: call } = await createTask(request, {
    title: "Synthetic venue call",
    kind: "step",
    parent_id: venue,
  });
  const state = await stubPlanning(page, {
    tasks: [
      outcome("launch", "Synthetic launch"),
      outcome(venue, "Synthetic venue booking"),
      step(call, "Synthetic venue call", venue),
    ],
    days: { "2026-10-13": [call] },
  });
  await openPlan(page);
  const dialog = await details(page, "Synthetic launch");
  const section = dialog.locator(".plus-dependencies");
  await section.getByRole("button", { name: "Add a dependency" }).click();
  const search = section.getByRole("combobox", {
    name: "Search tasks or parents",
  });
  await expect(search).toBeFocused();
  await search.fill("venue call");
  await search.press("Enter");
  await expect
    .poll(() => bodies(state, "/api/plus/v1/tasks:setTaskDependency"))
    .toEqual([
      {
        task_id: "launch",
        prerequisite_id: call,
        waits: true,
        request_id: expect.any(String),
      },
    ]);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  // A committed task that waits keeps its lane and says so.
  const waiting = page.getByRole("button", {
    name: /^Synthetic launch,.*Waiting for “Synthetic venue call”/u,
  });
  await expect(waiting).toBeVisible();

  await page.getByRole("link", { name: "Focus", exact: true }).click();
  const slot = page.locator(`.plus-focus-slot[data-task-id="${call}"]`);
  await slot
    .getByRole("button", { name: "Complete task: Synthetic venue call" })
    .click();
  await expect(
    slot.getByRole("button", { name: /^Complete task:/u }),
  ).toHaveCount(0);
  // Review asks Todofy about the prerequisite the read no longer lists, once.
  await page.getByRole("link", { name: "Plan", exact: true }).click();
  await expect
    .poll(() => bodies(state, "/api/plus/v1/tasks:resolveDependencies"))
    .toEqual([{ task_ids: [call], request_id: expect.any(String) }]);
  await expect(waiting).toHaveCount(0);
  expect(flowdayTaskWrites(state)).toEqual([]);
});

test("a deadline and its start-ahead days are saved in one SetTaskLead", async ({
  page,
}) => {
  const state = await stubPlanning(page, {
    tasks: [outcome("report", "Synthetic report")],
  });
  await openPlan(page);
  const dialog = await details(page, "Synthetic report");
  await dialog.getByLabel("Deadline", { exact: true }).fill("2026-10-23");
  await dialog.getByRole("spinbutton", { name: /^Start ahead/u }).fill("3");
  await dialog
    .locator(".plus-deadline-fields")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect
    .poll(() => bodies(state, "/api/plus/v1/tasks:setTaskLead"))
    .toEqual([
      {
        task_id: "report",
        etag: "1",
        request_id: expect.any(String),
        deadline: "2026-10-23",
        lead_days: 3,
      },
    ]);
  await expect(
    dialog.getByRole("spinbutton", { name: /^Start ahead/u }),
  ).toHaveValue("3");
});

test("Week schedules a step into a day and moves it to another with FlowDay's queues only", async ({
  page,
}) => {
  const state = await stubPlanning(page, {
    tasks: [
      outcome("website", "Synthetic website refresh"),
      step("intro", "Synthetic introduction", "website"),
    ],
  });
  // Wide enough for all seven days side by side.
  await page.setViewportSize({ width: 1800, height: 1000 });
  await openPlan(page);
  await page.getByRole("tab", { name: "Week", exact: true }).click();
  const tray = page.getByRole("region", {
    name: "Next steps: Synthetic website refresh",
  });
  const thursday = page.locator(
    '.planning-calendar-day[data-date="2026-10-15"]',
  );
  const friday = page.locator('.planning-calendar-day[data-date="2026-10-16"]');
  await drag(
    page,
    tray.getByRole("button", { name: "Drag step: Synthetic introduction" }),
    thursday.locator(".planning-day-end"),
  );
  await expect.poll(() => state.days["2026-10-15"]).toEqual(["intro"]);
  await expect(page.locator(".plus-page-header .plus-spin")).toHaveCount(0);
  await drag(
    page,
    thursday.getByRole("button", {
      name: "Drag scheduled step: Synthetic introduction",
    }),
    friday.locator(".planning-day-end"),
  );
  await expect.poll(() => state.days["2026-10-16"]).toEqual(["intro"]);
  expect(state.days["2026-10-15"]).toEqual([]);
  const writes = state.requests.filter((request) => request.method !== "GET");
  expect(writes.map((request) => [request.method, request.path])).toEqual([
    ["PATCH", "/api/plus/flowday/api/v1/flows/2026-10-15"],
    ["POST", "/api/plus/flowday/api/v1/flows/2026-10-15:rollover"],
  ]);
  expect(flowdayTaskWrites(state)).toEqual([]);
});

test("the weekly review link opens the checklist once and clears its parameter", async ({
  page,
}) => {
  await stubPlanning(page, {
    tasks: [outcome("launch", "Synthetic launch")],
  });
  await openPlan(page, "/?review=1#/plan");
  const review = page.getByRole("region", { name: "Weekly review" });
  await expect(review).toBeVisible();
  await expect.poll(() => new URL(page.url()).search).toBe("");
  await review.getByRole("button", { name: "Close", exact: true }).click();
  await expect(review).toHaveCount(0);
  // Plan remembers the closed checklist; only the link's parameter could open it again.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("tasks.plan-view") ?? "{}").review
            ?.open,
      ),
    )
    .toBe(false);
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Weekly goals" }),
  ).toBeVisible();
  await expect(review).toHaveCount(0);
});
