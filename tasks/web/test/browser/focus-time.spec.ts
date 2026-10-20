import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  addRecord,
  createTask,
  mondayOf,
  readFocus,
  stubPlanning,
  tasksToday,
  type Json,
} from "./planning-stub";

// Focus runs on Tasks' own today in the dev server's D1, so the page keeps the real clock.
test.use({ serviceWorkers: "block", timezoneId: "America/Los_Angeles" });
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

const outcome = (id: string, title: string, area: string): Json => ({
  id,
  kind: "task",
  title,
  area,
  stage: "committed",
  explicit_stage: "committed",
  planning_flags: [],
  etag: "1",
});
const step = (
  id: string,
  title: string,
  parent: string,
  minutes = 30,
): Json => ({
  id,
  kind: "step",
  title,
  parent_id: parent,
  area: "unassigned",
  stage: "none",
  explicit_stage: "none",
  planning_flags: [],
  etag: "1",
  estimated_minutes: minutes,
});
const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

/**
 * Outcomes and their steps in the dev server's D1 under their real parents, so a completion, the
 * records and Week's groups all see them; the planning list names them with the same IDs.
 */
async function plan(
  request: APIRequestContext,
  outcomes: { title: string; area: string; steps: string[] }[],
) {
  const tasks: Json[] = [];
  const ids: Record<string, string> = {};
  for (const item of outcomes) {
    const { id } = await createTask(request, { title: item.title });
    tasks.push(outcome(id, item.title, item.area));
    ids[item.title] = id;
    for (const title of item.steps) {
      const { id: stepId } = await createTask(request, {
        title,
        kind: "step",
        parent_id: id,
        duration_minutes: 30,
      });
      tasks.push(step(stepId, title, id));
      ids[title] = stepId;
    }
  }
  return { tasks, ids };
}
const card = (page: Page, id: string) =>
  page.locator(`.plus-focus-slot[data-task-id="${id}"]`);
const box = async (locator: Locator) => (await locator.boundingBox())!;
/** The page scrolls sideways when its content is wider than the window. */
const sideways = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

test("counting up and completing a step saves its session as one record, which Completed shows", async ({
  page,
  request,
}) => {
  // Tasks saves a session of a minute or more, so this one runs past a minute.
  test.setTimeout(180_000);
  const today = await tasksToday();
  const { tasks, ids } = await plan(request, [
    {
      title: "Synthetic Focus outcome",
      area: "work",
      steps: ["Synthetic counted step"],
    },
  ]);
  const counted = ids["Synthetic counted step"]!;
  await stubPlanning(
    page,
    { today, plan: { week_start: mondayOf(today) }, tasks },
    request,
  );
  // Plan › Week still drops a step into a day: today, in Tasks' queue.
  await page.setViewportSize({ width: 1800, height: 1000 });
  await page.goto("/#/plan");
  await page.getByRole("tab", { name: "Week", exact: true }).click();
  const grip = page
    .getByRole("region", { name: "Next steps: Synthetic Focus outcome" })
    .getByRole("button", { name: "Drag step: Synthetic counted step" });
  const end = page.locator(
    `.planning-calendar-day[data-date="${today}"] .planning-day-end`,
  );
  const from = await box(grip);
  const to = await box(end);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 8, from.y + from.height / 2, {
    steps: 3,
  });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
    steps: 18,
  });
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        ((await readFocus(today, today)).days as Json[])[0]?.task_ids ?? [],
    )
    .toEqual([counted]);

  await page.getByRole("link", { name: "Focus", exact: true }).click();
  const step = card(page, counted);
  // Counting up is the default.
  await expect(
    page.getByRole("combobox", { name: "Timer duration" }),
  ).toHaveValue("0");
  await step
    .getByRole("button", { name: "Start: Synthetic counted step" })
    .click();
  // The card's one time number ticks as a clock; there is no second one.
  const logged = step.locator(".plus-focus-logged");
  await expect(logged).toHaveText(/^00:0\d logged/u);
  await expect(step.locator("output")).toHaveCount(0);
  const before = await logged.textContent();
  await expect(logged).not.toHaveText(before!);
  await expect(logged).toHaveText(/^01:0\d logged/u, { timeout: 75_000 });
  // Completing the step ends the session and saves its whole minutes in the same Tasks write.
  await step
    .getByRole("button", { name: "Complete task: Synthetic counted step" })
    .click();
  await expect(step).toHaveCount(0);
  const read = await readFocus(today, today);
  expect(read.entries).toEqual([
    expect.objectContaining({
      task_id: counted,
      day: today,
      seconds: 60,
      source: "timer",
      area: "work",
    }),
  ]);
  expect((read.days as Json[])[0]?.done_task_ids).toEqual([counted]);
  await expect(page.locator(".plus-focus-totals")).toContainText("· 1m logged");
  // Completed shows it after the open steps, with its time; a reload starts unchecked.
  const completed = page.getByRole("checkbox", { name: "Completed" });
  await expect(completed).not.toBeChecked();
  await completed.check();
  const done = page
    .locator(".plus-focus-done")
    .locator(`.plus-focus-slot[data-task-id="${counted}"]`);
  await expect(done).toContainText("Synthetic counted step");
  await expect(done.locator(".plus-focus-estimate")).toHaveText("Est. 30m");
  await expect(done.locator(".plus-focus-logged")).toHaveAccessibleName(
    "1m logged (Synthetic counted step)",
  );
  await page.reload();
  await expect(
    page.getByRole("checkbox", { name: "Completed" }),
  ).not.toBeChecked();
  await expect(page.locator(".plus-focus-done")).toHaveCount(0);
});

test("a step's records change and grow in place, on yesterday too, and the popover keeps every position", async ({
  page,
  request,
}) => {
  const today = await tasksToday();
  const yesterday = addDays(today, -1);
  const { tasks, ids } = await plan(request, [
    {
      title: "Synthetic records outcome",
      area: "work",
      steps: ["Synthetic recorded step", "Synthetic step below"],
    },
  ]);
  const recorded = ids["Synthetic recorded step"]!;
  const state = await stubPlanning(page, {
    today,
    plan: { week_start: mondayOf(today) },
    tasks,
    queues: {
      [today]: [recorded, ids["Synthetic step below"]!],
      [yesterday]: [recorded],
    },
  });
  await addRecord(recorded, today, 25, "work");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/focus");
  const step = card(page, recorded);
  await expect(step.locator(".plus-focus-logged")).toHaveAccessibleName(
    "25m logged (Synthetic recorded step)",
  );
  // The card's edge is its area's colour.
  await expect(step.locator(".plus-focus-block")).toHaveCSS(
    "border-left-color",
    "rgb(99, 135, 163)",
  );
  const block = await box(step.locator(".plus-focus-block"));
  const scroll = await page.evaluate(() => window.scrollY);
  // First open: focus moves in; the card does not move or grow.
  await step.locator(".plus-focus-logged").click();
  const records = page.getByRole("dialog", {
    name: "Time records · Synthetic recorded step",
  });
  await expect(records).toBeFocused();
  const opened = await box(records);
  expect(await box(step.locator(".plus-focus-block"))).toEqual(block);
  // The record seeded first; the one added below is "added" too.
  const field = records
    .getByRole("spinbutton", { name: "Minutes, added" })
    .first();
  await expect(field).toHaveValue("25");
  const fieldAt = await box(field);
  await field.fill("40");
  await field.press("Enter");
  await expect(records.getByRole("status")).toHaveText("Saved");
  await expect(records).toContainText("Total 40m");
  await expect(step.locator(".plus-focus-logged")).toHaveAccessibleName(
    "40m logged (Synthetic recorded step)",
  );
  await expect(page.locator(".plus-focus-totals")).toContainText(
    "· 40m logged",
  );
  // A record arriving while it is open joins the list; nothing above it moves.
  await records.getByRole("button", { name: "Add time" }).click();
  await records.getByRole("spinbutton", { name: "Add time" }).press("Enter");
  await expect(records.getByRole("spinbutton")).toHaveCount(2);
  await expect(records).toContainText("Total 55m");
  expect(await box(field)).toEqual(fieldAt);
  expect((await box(records)).y).toBe(opened.y);
  expect(await box(step.locator(".plus-focus-block"))).toEqual(block);
  expect(await page.evaluate(() => window.scrollY)).toBe(scroll);
  expect(
    state.tasksRequests
      .filter((request) => request.method !== "GET")
      .map((request) =>
        request.path.split("?")[0]!.replace(/[0-9a-f-]{36}/u, "ID"),
      ),
  ).toEqual(["/api/tasks/v1/focusEntries/ID", "/api/tasks/v1/focusEntries"]);
  // Escape closes and focus goes back; the cached reopen is drawn where it was.
  await page.keyboard.press("Escape");
  await expect(records).toHaveCount(0);
  await expect(step.locator(".plus-focus-logged")).toBeFocused();
  await step.locator(".plus-focus-logged").click();
  expect((await box(records)).x).toBe(opened.x);
  expect((await box(records)).y).toBe(opened.y);
  // Tab out of the popover closes it.
  await records.getByRole("button", { name: "Add time" }).focus();
  await page.keyboard.press("Tab");
  await expect(records).toHaveCount(0);

  // Yesterday is read-only, but time can still be added there.
  await page.getByRole("button", { name: "Previous day" }).click();
  const earlier = card(page, recorded);
  await expect(earlier).toBeVisible();
  await expect(earlier.getByRole("button", { name: /^Start:/u })).toHaveCount(
    0,
  );
  await earlier
    .getByRole("button", { name: "Log time (Synthetic recorded step)" })
    .click();
  const yesterdays = page.getByRole("dialog");
  await yesterdays.getByRole("button", { name: "Add time" }).click();
  await yesterdays.getByRole("spinbutton", { name: "Add time" }).press("Enter");
  await expect(yesterdays).toContainText("Total 15m");
  await expect
    .poll(async () =>
      ((await readFocus(yesterday, yesterday)).entries as Json[]).map(
        (entry) => [entry.task_id, entry.seconds, entry.area],
      ),
    )
    .toEqual([[recorded, 900, "work"]]);
  await page.keyboard.press("Escape");

  // On a phone the popover stays inside the window, and the page never scrolls sideways.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await card(page, recorded).locator(".plus-focus-logged").click();
  const narrow = await box(page.getByRole("dialog"));
  expect(narrow.x).toBeGreaterThanOrEqual(0);
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(375);
  expect(await sideways(page)).toBe(false);
});

test("Week's totals and bars follow the records, and Month's day opens in Day", async ({
  page,
  request,
}, testInfo) => {
  const today = await tasksToday();
  const { tasks, ids } = await plan(request, [
    {
      title: "Synthetic work outcome",
      area: "work",
      steps: ["Synthetic work step"],
    },
    {
      title: "Synthetic personal outcome",
      area: "personal",
      steps: ["Synthetic personal step"],
    },
  ]);
  const work = ids["Synthetic work step"]!;
  const personal = ids["Synthetic personal step"]!;
  await stubPlanning(page, {
    today,
    plan: { week_start: mondayOf(today) },
    tasks,
    queues: { [today]: [work, personal] },
  });
  await addRecord(work, today, 30, "work");
  await addRecord(work, today, 15, "work");
  await addRecord(personal, today, 20, "personal");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/focus");
  await expect(card(page, work)).toBeVisible();
  await page.getByRole("tab", { name: "Week" }).click();
  const stats = page.locator(".plus-focus-stats");
  await expect(stats.locator("dd")).toHaveText(["1h 5m", "45m", "20m", "0"]);
  const bars = page.locator(".plus-focus-bars > button");
  await expect(bars).toHaveCount(7);
  const todayBar = bars.nth(
    (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7,
  );
  await expect(todayBar).toHaveAccessibleName(
    /: 1h 5m logged, work 45m, personal 20m, 0 of 2 steps done$/u,
  );
  await expect(todayBar).toHaveClass("is-today");
  // The busiest day's bar is the full 120px, Work under Personal in proportion.
  const [workPart, personalPart] = await todayBar
    .locator(".plus-focus-bar > span")
    .evaluateAll((parts) =>
      parts.map((part) => part.getBoundingClientRect().height),
    );
  expect(workPart! + personalPart!).toBeCloseTo(120, 0);
  expect(workPart! / personalPart!).toBeCloseTo(45 / 20, 1);
  // Where the time went: by each step's outcome, the largest first.
  await expect(
    page.locator(".plus-focus-group .planning-full-title-text"),
  ).toHaveText(["Synthetic work outcome", "Synthetic personal outcome"]);
  await expect(page.locator(".plus-focus-group-time")).toHaveText([
    "45m",
    "20m",
  ]);
  await page.screenshot({
    path: testInfo.outputPath("focus-week-1440.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Month" }).click();
  const day = page.locator(".plus-focus-month-day.is-today");
  await expect(day).toHaveAccessibleName(
    /: 1h 5m logged, work 45m, personal 20m, 0 of 2 steps done$/u,
  );
  await expect(day).toHaveAttribute("data-level", "2");
  await page.screenshot({
    path: testInfo.outputPath("focus-month-1440.png"),
    fullPage: true,
  });
  // On a phone, neither scrolls sideways.
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await sideways(page)).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("focus-month-375.png"),
    fullPage: true,
  });
  await page.getByRole("tab", { name: "Week" }).click();
  await expect(bars).toHaveCount(7);
  expect(await sideways(page)).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("focus-week-375.png"),
    fullPage: true,
  });
  // Month's day opens that day in Day.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("tab", { name: "Month" }).click();
  await day.click();
  await expect(page.getByRole("tab", { name: "Day" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(card(page, work)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Today", exact: true }),
  ).toBeDisabled();
});
