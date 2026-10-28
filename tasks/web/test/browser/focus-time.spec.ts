import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  addDays,
  addRecord,
  readFocus,
  stubPlanning,
  tasksToday,
  type Json,
  type SeedTask,
} from "./planning-stub";

// Focus runs on Tasks' own today in the dev server's D1, so the page keeps the real clock.
test.use({ serviceWorkers: "block", timezoneId: "America/Los_Angeles" });
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

/**
 * Outcomes and their steps, seeded in the dev server's D1 under their parents, so a completion,
 * the records and Week's groups all see them.
 */
function plan(outcomes: { title: string; area: string; steps: string[] }[]) {
  const tasks: SeedTask[] = [];
  const ids: Record<string, string> = {};
  for (const item of outcomes) {
    const id = crypto.randomUUID();
    tasks.push({ id, title: item.title, area: item.area, stage: "committed" });
    ids[item.title] = id;
    for (const title of item.steps) {
      const stepId = crypto.randomUUID();
      tasks.push({
        id: stepId,
        title,
        kind: "step",
        parent_id: id,
        duration_minutes: 30,
      });
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
}) => {
  // Tasks saves a session of a minute or more, so this one runs past a minute.
  test.setTimeout(180_000);
  const today = await tasksToday();
  const { tasks, ids } = plan([
    {
      title: "Synthetic Focus outcome",
      area: "work",
      steps: ["Synthetic counted step"],
    },
  ]);
  const counted = ids["Synthetic counted step"]!;
  await stubPlanning(page, { tasks });
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
  // The running step's grip cannot move it, and stays hidden unless hover shows it.
  const stepGrip = step.locator(".plus-focus-grip");
  await expect(stepGrip).toBeDisabled();
  await page.mouse.move(0, 0);
  expect(
    await stepGrip.evaluate((node) => getComputedStyle(node).opacity),
  ).toBe("0");
  // Past 01:00 by a second, so Tasks' own count has reached a whole minute too.
  await expect(logged).toHaveText(/^01:0[1-9] logged/u, { timeout: 75_000 });
  // Completing the step ends the session and saves its whole minutes in the same Tasks write.
  await step
    .getByRole("button", { name: "Complete task: Synthetic counted step" })
    .click();
  await expect(step).toHaveCount(0);
  // The card leaves at once; the write lands after it.
  await expect
    .poll(async () => (await readFocus(today, today)).entries)
    .toBeDefined();
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
}) => {
  const today = await tasksToday();
  const yesterday = addDays(today, -1);
  const { tasks, ids } = plan([
    {
      title: "Synthetic records outcome",
      area: "work",
      steps: ["Synthetic recorded step", "Synthetic step below"],
    },
  ]);
  const recorded = ids["Synthetic recorded step"]!;
  const state = await stubPlanning(page, {
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

test("Focus statistics open GTD Time, and its calendar returns to editable daily records", async ({
  page,
}, testInfo) => {
  const today = await tasksToday();
  const { tasks, ids } = plan([
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
    tasks: tasks.map((task) =>
      task.kind === "step" ? task : { ...task, duration_minutes: 60 },
    ),
    queues: { [today]: [work, personal] },
  });
  await addRecord(work, today, 30, "work");
  await addRecord(work, today, 15, "work");
  await addRecord(personal, today, 20, "personal");
  await page.setViewportSize({ width: 1489, height: 1056 });
  await page.goto("/#/focus");
  await expect(card(page, work)).toBeVisible();
  await page.getByRole("button", { name: "View statistics", exact: true }).click();
  await expect(page).toHaveURL(/#\/gtd\/time$/u);
  await expect(page.getByRole("tab", { name: "Time", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const stats = page.locator('dl[aria-label="Recorded time totals"]');
  const totals = stats.locator(":scope > div > dd:first-of-type");
  await expect(totals).toHaveText(["1h 5m", "45m", "20m"]);
  const bars = page.locator(".gtd-time .gtd-time-bars > button");
  await expect(bars).toHaveCount(7);
  await expect(bars.first()).toHaveAccessibleName(/^Sun,/u);
  const todayBar = page.locator(".gtd-time .gtd-time-bars > button.is-today");
  await expect(todayBar).toHaveAccessibleName(
    /: 1h 5m recorded, Work 45m, Personal 20m$/u,
  );
  await expect(todayBar).toHaveClass("is-today");
  const [workPart, personalPart] = await todayBar
    .locator(".gtd-time-bar > span")
    .evaluateAll((parts) =>
      parts.map((part) => part.getBoundingClientRect().height),
    );
  const fullBar = await box(todayBar.locator(".gtd-time-bar"));
  expect(workPart! + personalPart!).toBeCloseTo(fullBar.height, 0);
  expect(workPart! / personalPart!).toBeCloseTo(45 / 20, 1);
  await expect(page.locator(".gtd-time-task-title")).toHaveText([
    "Synthetic work outcome",
    "Synthetic personal outcome",
  ]);
  await expect(page.locator(".gtd-time-task-row > span:first-of-type")).toHaveText([
    "45m",
    "20m",
  ]);
  await expect(page.locator(".gtd-time-estimate")).toHaveText(["1h", "1h"]);
  await page.screenshot({
    path: testInfo.outputPath("gtd-time-week-1489.png"),
    fullPage: true,
  });
  const period = page.getByRole("group", { name: "GTD period" });
  await period.getByRole("button", { name: "Month", exact: true }).click();
  const day = page.locator(".gtd-time .gtd-time-month-day.is-today");
  await expect(day).toHaveAccessibleName(
    /: 1h 5m recorded, Work 45m, Personal 20m$/u,
  );
  await expect(day).toHaveAttribute("data-level", "2");
  await page.screenshot({
    path: testInfo.outputPath("gtd-time-month-1489.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 375, height: 812 });
  expect(await sideways(page)).toBe(false);
  await page.screenshot({
    path: testInfo.outputPath("gtd-time-month-375.png"),
    fullPage: true,
  });
  await period.getByRole("button", { name: "Week", exact: true }).click();
  await expect(bars).toHaveCount(7);
  expect(await sideways(page)).toBe(false);
  const labels = await page.locator(".gtd-time-bar-day").evaluateAll((days) =>
    days.map((day) => day.getBoundingClientRect().height),
  );
  expect(labels[0]).toBeGreaterThan(0);
  expect(new Set(labels).size).toBe(1);
  await page.screenshot({
    path: testInfo.outputPath("gtd-time-week-375.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1489, height: 1056 });
  await period.getByRole("button", { name: "Month", exact: true }).click();
  await day.click();
  await expect(page).toHaveURL(new RegExp(`#/focus/${today}$`, "u"));
  await expect(card(page, work)).toBeVisible();
  await card(page, work).locator(".plus-focus-logged").click();
  const records = page.getByRole("dialog", {
    name: "Time records · Synthetic work step",
  });
  const minutes = records.getByRole("spinbutton", { name: "Minutes, added" }).first();
  await expect(minutes).toHaveValue("30");
  await minutes.fill("35");
  await minutes.press("Enter");
  await expect(records.getByRole("status")).toHaveText("Saved");
  await expect(records).toContainText("Total 50m");
  await expect.poll(async () =>
    ((await readFocus(today, today)).entries as Json[])
      .filter((entry) => entry.task_id === work)
      .reduce((sum, entry) => sum + Number(entry.seconds), 0),
  ).toBe(3000);
});
