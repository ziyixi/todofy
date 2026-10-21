import { expect, test, type Page } from "@playwright/test";
import {
  readFocus,
  readTimer,
  stubPlanning,
  tasksToday,
  type Json,
  type SeedTask,
} from "./planning-stub";

// Document Picture-in-Picture is real in headless Chromium: the mini timer's window is a Playwright page of
// this context. Only its size is set by the test: headless Chrome opens it at the context's viewport, not at
// the 320 × 120 the page asks for. Focus runs on the dev server's D1 and real clock.
test.use({ serviceWorkers: "block" });
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

const OUTCOME = crypto.randomUUID();
const STEP = crypto.randomUUID();
const NEXT = crypto.randomUUID();
const tasks: SeedTask[] = [
  { id: OUTCOME, title: "Q4 planning", area: "work", stage: "committed" },
  {
    id: STEP,
    title: "Draft the quarterly review",
    kind: "step",
    parent_id: OUTCOME,
    duration_minutes: 45,
  },
  {
    id: NEXT,
    title: "Send the review to the team",
    kind: "step",
    parent_id: OUTCOME,
    duration_minutes: 15,
  },
];

/** Presses the timer bar's toggle and answers the mini timer's window, sized as Chrome first opens it. */
async function openMiniTimer(page: Page) {
  const [pip] = await Promise.all([
    page.context().waitForEvent("page"),
    page.getByRole("button", { name: "Mini timer" }).click(),
  ]);
  await pip.setViewportSize({ width: 320, height: 120 });
  return pip;
}
const bar = (page: Page) => page.getByRole("complementary", { name: "Focus" });

test("the mini timer floats the session, acts through Focus's own commands and closes cleanly", async ({
  page,
}) => {
  // Tasks saves a session of a minute or more, so this one runs past a minute.
  test.setTimeout(180_000);
  const today = await tasksToday();
  await stubPlanning(page, { tasks, queues: { [today]: [STEP, NEXT] } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/focus");
  await page
    .getByRole("button", { name: "Start: Draft the quarterly review" })
    .click();
  const toggle = bar(page).getByRole("button", { name: "Mini timer" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");

  const pip = await openMiniTimer(page);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(await pip.title()).toBe("Focus");
  await expect(pip.locator("html")).toHaveAttribute("lang", "en");
  // Its stylesheet and the page's tokens: Tasks' calmer accent for Plan and Focus, not planning-ui's own.
  const accent = (target: Page, selector: string) =>
    target
      .locator(selector)
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue("--plus-accent").trim(),
      );
  expect(await accent(pip, "html")).toBe(await accent(page, ".plus-root"));
  expect(await accent(pip, "html")).toBe("#50743b");
  await expect(pip.locator(".mini-time")).toHaveCSS("font-weight", "250");
  await expect(pip.locator(".mini-title")).toHaveText(
    "Draft the quarterly review",
  );
  await expect(pip.locator(".mini-label")).toHaveText("45m");
  await expect(pip.locator(".mini-fill")).toHaveCSS(
    "background-color",
    "rgb(99, 135, 163)",
  );
  // It ticks on its own.
  const time = pip.getByRole("timer");
  await expect(time).toHaveText(/^00:0\d$/u);
  const first = await time.textContent();
  await expect(time).not.toHaveText(first!);
  // At rest only the time and the rule; the controls show on hover.
  const pause = pip.getByRole("button", {
    name: "Pause: Draft the quarterly review",
  });
  await pip.mouse.move(0, 0);
  await expect(pip.locator(".mini-controls")).toHaveCSS("opacity", "0");
  await pip.mouse.move(250, 60);
  await expect(pip.locator(".mini-controls")).toHaveCSS("opacity", "1");

  // Pause and Resume in the mini timer are the timer bar's own commands.
  await pause.click();
  await expect(bar(page).locator("small")).toHaveText("Paused");
  await expect(pip.locator(".mini")).toHaveAttribute("data-status", "paused");
  await expect(pip.locator(".mini-status")).toHaveText("Paused");
  await pip
    .getByRole("button", { name: "Resume: Draft the quarterly review" })
    .click();
  await expect(bar(page).locator("small")).toHaveText("Focus");

  // On another page the window stays and its controls still work.
  await page.getByRole("link", { name: "Today", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
  await expect(bar(page)).toHaveCount(0);
  expect(pip.isClosed()).toBe(false);
  await pause.click();
  await expect.poll(async () => (await readTimer()).state).toBe("paused");
  await expect(pip.locator(".mini-status")).toHaveText("Paused");
  await pip
    .getByRole("button", { name: "Resume: Draft the quarterly review" })
    .click();
  await expect.poll(async () => (await readTimer()).state).toBe("running");
  await page.getByRole("link", { name: "Focus", exact: true }).click();
  await expect(bar(page).locator("small")).toHaveText("Focus");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");

  // Past 01:00 by a second, so Tasks' own count has reached a whole minute too.
  await expect(time).toHaveText(/^01:0[1-9]$/u, { timeout: 75_000 });
  // Complete: the same completion as the bar's, which closes the window once confirmed.
  await Promise.all([
    pip.waitForEvent("close"),
    pip
      .getByRole("button", { name: "Complete task: Draft the quarterly review" })
      .click(),
  ]);
  await expect(
    page.locator(`.plus-focus-slot[data-task-id="${STEP}"]`),
  ).toHaveCount(0);
  await expect
    .poll(async () => ((await readFocus(today, today)).days as Json[])[0])
    .toMatchObject({ done_task_ids: [STEP] });
  const read = await readFocus(today, today);
  expect(read.entries).toEqual([
    expect.objectContaining({
      task_id: STEP,
      seconds: 60,
      source: "timer",
      area: "work",
    }),
  ]);

  // A new session: the bar's toggle closes the window it opened, and so does the owner.
  await page
    .getByRole("button", { name: "Start: Send the review to the team" })
    .click();
  const second = await openMiniTimer(page);
  await expect(second.locator(".mini-title")).toHaveText(
    "Send the review to the team",
  );
  await Promise.all([second.waitForEvent("close"), toggle.click()]);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const third = await openMiniTimer(page);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await third.close();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
});

test("a session ended on another page closes the window and lets Plan/Focus go", async ({
  page,
}) => {
  const today = await tasksToday();
  await stubPlanning(page, { tasks, queues: { [today]: [STEP] } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/focus");
  await page
    .getByRole("button", { name: "Start: Draft the quarterly review" })
    .click();
  const pip = await openMiniTimer(page);
  await page.getByRole("link", { name: "Today", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
  // No planning page shows, and none is drawn behind Today.
  await expect(page.locator(".plus-root")).toHaveCount(0);
  await Promise.all([
    pip.waitForEvent("close"),
    pip
      .getByRole("button", { name: "Stop session: Draft the quarterly review" })
      .click(),
  ]);
  expect((await readTimer()).state ?? "idle").not.toMatch(/running|paused/u);
  await expect(page.locator(".planning-ui")).toHaveCount(0);
});

test("an outcome completed on another page ends its step's session in the mini timer at once", async ({
  page,
}) => {
  const today = await tasksToday();
  const outcome = crypto.randomUUID();
  const step = crypto.randomUUID();
  const name = `Synthetic outcome done elsewhere ${outcome.slice(0, 8)}`;
  const title = `Synthetic step done elsewhere ${step.slice(0, 8)}`;
  await stubPlanning(page, {
    tasks: [
      { id: outcome, title: name, area: "work", stage: "committed" },
      { id: step, title, kind: "step", parent_id: outcome },
    ],
    queues: { [today]: [step] },
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/focus");
  await page.getByRole("button", { name: `Start: ${title}` }).click();
  const pip = await openMiniTimer(page);
  await page.getByRole("link", { name: "Synthetic planning" }).click();
  // Long before the minute's timer read: the read that follows the write shows the session ended.
  const started = Date.now();
  await Promise.all([
    pip.waitForEvent("close", { timeout: 10_000 }),
    page.getByRole("button", { name: `Complete ${name}` }).click(),
  ]);
  expect(Date.now() - started).toBeLessThan(10_000);
  expect((await readTimer()).state ?? "idle").not.toMatch(/running|paused/u);
  await expect(page.locator(".planning-ui")).toHaveCount(0);
});
