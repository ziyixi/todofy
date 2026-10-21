import { expect, test, type CDPSession, type Page } from "@playwright/test";
import {
  readTimer,
  startTimer,
  stubPlanning,
  tasksToday,
  type SeedTask,
} from "./planning-stub";

// The Idle Detection API is real in headless Chromium. Stubbed: the permission, granted through browser-level CDP
// (Playwright's grantPermissions refuses idle-detection; no prompt can show headless), and the OS's idle and lock
// states, which CDP's Emulation.setIdleOverride sets. Focus runs on the dev server's D1 and real clock.
test.use({ serviceWorkers: "block" });
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

const OUTCOME = crypto.randomUUID();
const STEP = crypto.randomUUID();
const tasks: SeedTask[] = [
  { id: OUTCOME, title: "Synthetic away outcome", area: "work", stage: "committed" },
  {
    id: STEP,
    title: "Synthetic away step",
    kind: "step",
    parent_id: OUTCOME,
    duration_minutes: 45,
  },
];
const bar = (page: Page) => page.getByRole("complementary", { name: "Focus" });

/** Grants idle-detection to the page's origin and answers the page's CDP session, set active and unlocked. */
async function idleControls(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  const browser = await page.context().browser()!.newBrowserCDPSession();
  await browser.send("Browser.grantPermissions", {
    origin: "http://127.0.0.1:8798",
    permissions: ["idleDetection"],
    browserContextId: targetInfo.browserContextId,
  });
  await cdp.send("Emulation.setIdleOverride", {
    isUserActive: true,
    isScreenUnlocked: true,
  });
  return cdp;
}
async function setIdle(
  cdp: CDPSession,
  isUserActive: boolean,
  isScreenUnlocked: boolean,
) {
  await cdp.send("Emulation.setIdleOverride", {
    isUserActive,
    isScreenUnlocked,
  });
}
const ms = (time: unknown) => Date.parse(String(time));
/**
 * Once the page holds the watch (its Web Lock) and its detector started, the owner is seen active and unlocked:
 * headless Chromium reports idle at a detector's start, which only arms it.
 */
async function seenActive(page: Page, cdp: CDPSession) {
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await navigator.locks.query()).held?.map((lock) => lock.name),
      ),
    )
    .toEqual(["tasks.idle-pause"]);
  await page.waitForTimeout(300);
  await setIdle(cdp, false, true);
  await setIdle(cdp, true, true);
}

test("a count-up pauses when the screen locks and asks on return; Keep counts the away time, Discard does not", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const today = await tasksToday();
  await stubPlanning(page, { tasks, queues: { [today]: [STEP] } });
  await page.setViewportSize({ width: 1440, height: 900 });
  const cdp = await idleControls(page);
  await page.goto("/#/focus");
  const toggle = page.getByRole("checkbox", { name: "Pause when away" });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  expect(
    await page.evaluate(() => localStorage.getItem("tasks.idle-pause")),
  ).toBe("on");
  await page
    .getByRole("button", { name: "Start: Synthetic away step" })
    .click();
  await expect(bar(page).locator("small")).toHaveText("Focus");
  const [pip] = await Promise.all([
    page.context().waitForEvent("page"),
    bar(page).getByRole("button", { name: "Mini timer" }).click(),
  ]);
  await pip.setViewportSize({ width: 320, height: 120 });
  await seenActive(page, cdp);

  // Locked: paused in Tasks at that moment.
  await page.waitForTimeout(2000);
  const locked = Date.now();
  await setIdle(cdp, true, false);
  await expect(bar(page).locator("small")).toHaveText("Paused");
  const paused = await readTimer();
  expect(paused.state).toBe("paused");
  expect(ms(paused.pause_time)).toBeGreaterThanOrEqual(locked - 50);
  expect(ms(paused.pause_time)).toBeLessThanOrEqual(Date.now());

  // Back: one question in the bar and in the mini timer.
  await setIdle(cdp, true, true);
  await expect(bar(page).locator("small")).toHaveText(
    "Away for 1 min — count it?",
  );
  await expect(
    bar(page).getByRole("button", { name: "Resume" }),
  ).toHaveCount(0);
  await expect(pip.getByRole("status")).toHaveText(
    "Away for 1 min — count it?",
  );
  await expect(pip.locator(".mini")).toHaveAttribute("data-away", "");
  // The question keeps one line of its own above the bar's row, in a narrow window too, where only the title
  // gives way; the card offers the same answers in Resume's place.
  for (const width of [790, 500]) {
    await page.setViewportSize({ width, height: 900 });
    const question = (await bar(page)
      .locator(".plus-away-question")
      .boundingBox())!;
    const title = (await bar(page).locator("strong").boundingBox())!;
    const keep = (await bar(page)
      .getByRole("button", { name: "Keep" })
      .boundingBox())!;
    const box = (await bar(page).boundingBox())!;
    expect(question.height).toBeLessThan(20);
    expect(question.y + question.height).toBeLessThanOrEqual(title.y);
    expect(keep.x + keep.width).toBeLessThanOrEqual(box.x + box.width);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(
    page.getByRole("button", { name: "Keep: Synthetic away step" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Resume: Synthetic away step" }),
  ).toHaveCount(0);
  await pip.getByRole("button", { name: "Keep" }).click();
  await expect(bar(page).locator("small")).toHaveText("Focus");
  await expect(pip.locator(".mini")).not.toHaveAttribute("data-away");
  const kept = await readTimer();
  expect(kept.state).toBe("running");
  // Resumed at the pause: the session counts as if it never paused.
  expect(kept.segment_start_time).toBe(paused.pause_time);
  expect(kept.pause_time).toBeUndefined();

  // Again, and Discard: counting resumes from the answer.
  await setIdle(cdp, true, false);
  await expect(bar(page).locator("small")).toHaveText("Paused");
  const second = await readTimer();
  await page.waitForTimeout(1500);
  await setIdle(cdp, true, true);
  const answered = Date.now();
  await bar(page).getByRole("button", { name: "Discard" }).click();
  await expect(bar(page).locator("small")).toHaveText("Focus");
  const discarded = await readTimer();
  expect(ms(discarded.segment_start_time)).toBeGreaterThanOrEqual(answered);
  expect(ms(discarded.segment_start_time)).toBeGreaterThan(
    ms(second.pause_time) + 1000,
  );
  expect(discarded.saved_seconds).toBe(second.saved_seconds);

  // No input for the threshold: idleness began ten minutes before the report, before this segment began, so
  // Tasks moves the pause to the segment's start and the segment counts nothing.
  await setIdle(cdp, false, true);
  await expect(bar(page).locator("small")).toHaveText("Paused");
  const idle = await readTimer();
  expect(idle.pause_time).toBe(discarded.segment_start_time);
  expect(idle.saved_seconds).toBe(discarded.saved_seconds);
  await setIdle(cdp, true, true);
  await expect(bar(page).locator("small")).toHaveText(
    "Away for 1 min — count it?",
  );
  // Stop while the question waits ends the paused session: the away time is not counted.
  await Promise.all([
    pip.waitForEvent("close"),
    bar(page).getByRole("button", { name: "Stop session" }).click(),
  ]);
  await expect(bar(page)).toHaveCount(0);
});

test("a pomodoro is not paused when away", async ({ page }) => {
  const today = await tasksToday();
  await stubPlanning(page, { tasks, queues: { [today]: [STEP] } });
  await page.setViewportSize({ width: 1440, height: 900 });
  const cdp = await idleControls(page);
  await page.addInitScript(() => localStorage.setItem("tasks.idle-pause", "on"));
  await page.goto("/#/focus");
  await expect(
    page.getByRole("checkbox", { name: "Pause when away" }),
  ).toBeChecked();
  await page
    .getByRole("combobox", { name: "Timer duration" })
    .selectOption({ label: "25 min" });
  await page
    .getByRole("button", { name: "Start: Synthetic away step" })
    .click();
  await expect(bar(page).locator("small")).toHaveText("Focus");
  // Nothing watches a pomodoro, so no detector starts.
  await page.waitForTimeout(500);
  expect(
    await page.evaluate(async () => (await navigator.locks.query()).held),
  ).toEqual([]);
  await setIdle(cdp, true, false);
  await page.waitForTimeout(1000);
  await setIdle(cdp, false, false);
  await page.waitForTimeout(1000);
  expect((await readTimer()).state).toBe("running");
  await expect(bar(page).locator("small")).toHaveText("Focus");
  await bar(page).getByRole("button", { name: "Stop session" }).click();
  await expect(bar(page)).toHaveCount(0);
});

test("after a reload on another page, a running count-up is still watched", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const today = await tasksToday();
  await stubPlanning(page, { tasks, queues: { [today]: [STEP] } });
  await page.setViewportSize({ width: 1440, height: 900 });
  const cdp = await idleControls(page);
  await page.addInitScript(() => localStorage.setItem("tasks.idle-pause", "on"));
  await page.goto("/#/focus");
  await page
    .getByRole("button", { name: "Start: Synthetic away step" })
    .click();
  await expect(bar(page).locator("small")).toHaveText("Focus");
  // Today, reloaded (as the reload prompt after a deploy does): nothing has shown Plan or Focus in this page.
  await page.getByRole("link", { name: "Today", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
  await seenActive(page, cdp);
  await page.waitForTimeout(1000);
  const locked = Date.now();
  await setIdle(cdp, true, false);
  await expect.poll(async () => (await readTimer()).state).toBe("paused");
  expect(ms((await readTimer()).pause_time)).toBeGreaterThanOrEqual(
    locked - 50,
  );
  // Back: the question shows over Today, and an answer lets it go.
  await setIdle(cdp, true, true);
  await expect(bar(page).locator("small")).toHaveText(
    "Away for 1 min — count it?",
  );
  await bar(page).getByRole("button", { name: "Keep" }).click();
  await expect(bar(page)).toHaveCount(0);
  expect((await readTimer()).state).toBe("running");
});

test("with the setting off, a page other than Plan or Focus reads no timer", async ({
  page,
}) => {
  const today = await tasksToday();
  const state = await stubPlanning(page, { tasks, queues: { [today]: [STEP] } });
  await startTimer(STEP);
  await page.goto("/#/today");
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(500);
  expect(
    state.tasksRequests.filter((sent) => sent.path.includes("focusTimer")),
  ).toEqual([]);
  await expect(page.locator(".planning-ui")).toHaveCount(0);
});
