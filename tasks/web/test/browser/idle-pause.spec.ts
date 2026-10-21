import { expect, test, type CDPSession, type Page } from "@playwright/test";
import {
  readTimer,
  startTimer,
  stubPlanning,
  tasksToday,
  type PlanningState,
  type SeedTask,
} from "./planning-stub";

// The Idle Detection API is real in headless Chromium. Stubbed: the permission, granted through browser-level CDP
// (Playwright's grantPermissions refuses idle-detection; no prompt can show headless), and the OS's idle and lock
// states, which CDP's Emulation.setIdleOverride sets for the current document only. Focus runs on the dev server's
// D1 and real clock; the page runs on Playwright's clock, which follows the real one until a step holds it at the
// moment the owner leaves or comes back, so each moment Tasks is sent is known exactly.
test.use({ serviceWorkers: "block" });
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

const MIN = 60_000;
/** No input for this long reads as idle: the detector's threshold in Tasks. */
const AWAY = 10 * MIN;
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

/** The part of an IdleDetector the test reads. */
interface Detector extends EventTarget {
  readonly userState: string | null;
  readonly screenState: string | null;
  start(options: unknown): Promise<void>;
}
type Noted = { idleDetectors?: Detector[] };

/**
 * Grants idle-detection to the page's origin, notes each detector Tasks starts once its first reading is in, and
 * installs Playwright's clock. Answers the page's CDP session.
 */
async function idleControls(page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  const { targetInfo } = await cdp.send("Target.getTargetInfo");
  const browser = await page.context().browser()!.newBrowserCDPSession();
  await browser.send("Browser.grantPermissions", {
    origin: "http://127.0.0.1:8798",
    permissions: ["idleDetection"],
    browserContextId: targetInfo.browserContextId,
  });
  await page.addInitScript(() => {
    const api = (
      window as unknown as { IdleDetector?: { prototype: Detector } }
    ).IdleDetector;
    if (!api) return;
    const noted: Detector[] = [];
    (window as Noted).idleDetectors = noted;
    const start = api.prototype.start;
    api.prototype.start = function (this: Detector, options: unknown) {
      const started = start.call(this, options);
      // Tasks reports the first reading from this promise too, in the same microtask checkpoint.
      started.then(
        () => noted.push(this),
        () => {},
      );
      return started;
    };
  });
  await page.clock.install();
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
/** What the page's latest detector reads, as "active/unlocked"; undefined until one reported its first reading. */
const detectorReads = (page: Page) =>
  page.evaluate(() => {
    const detector = (window as Noted).idleDetectors?.at(-1);
    return detector && `${detector.userState}/${detector.screenState}`;
  });
const ms = (time: unknown) => Date.parse(String(time));
/** The bodies of the page's timer commands so far, first to last. */
const timerCommands = (state: PlanningState) =>
  state.tasksRequests
    .filter((sent) => sent.path === "/api/tasks/v1/focusTimer:command")
    .map((sent) => sent.body);
/**
 * Once the page holds the watch (its Web Lock) and its detector reported its first reading, the owner is seen active
 * and unlocked, so the page watches. That first reading is a baseline, whatever it is (`first`, when the test set it
 * in this document): with no emulation in the document it is the host's own input state (idle on a Mac nobody
 * touched for ten minutes, active on a CI runner), which arms or watches; active and unlocked then watches either
 * way, and nothing here reads as leaving.
 */
async function seenActive(page: Page, cdp: CDPSession, first?: string) {
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await navigator.locks.query()).held?.map((lock) => lock.name),
      ),
    )
    .toEqual(["tasks.idle-pause"]);
  await expect.poll(() => detectorReads(page)).toBeDefined();
  if (first) expect(await detectorReads(page)).toBe(first);
  await setIdle(cdp, true, true);
  await expect.poll(() => detectorReads(page)).toBe("active/unlocked");
}
/** The owner's state changes at `time` on the page's clock, which holds that moment until the next change. */
async function setIdleAt(
  page: Page,
  cdp: CDPSession,
  time: number,
  isUserActive: boolean,
  isScreenUnlocked: boolean,
) {
  await page.clock.setFixedTime(time);
  await setIdle(cdp, isUserActive, isScreenUnlocked);
}

test("a count-up pauses when the screen locks and asks on return; Keep counts the away time, Discard does not", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const today = await tasksToday();
  const state = await stubPlanning(page, { tasks, queues: { [today]: [STEP] } });
  await page.setViewportSize({ width: 1440, height: 900 });
  const cdp = await idleControls(page);
  await page.goto("/#/focus");
  // Emulated in this document before the detector starts, so its first reading is a locked screen (an idle override
  // would read active: it is below Tasks' ten-minute threshold). A session started then, from the phone say, only
  // arms, and is watched once the owner is seen active and unlocked.
  await setIdle(cdp, true, false);
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
  await seenActive(page, cdp, "active/locked");
  const started = await readTimer();
  expect(started.state).toBe("running");

  // Locked: paused in Tasks at exactly that moment, and while away the bar says Paused.
  const locked = Date.now();
  await setIdleAt(page, cdp, locked, true, false);
  await expect(bar(page).locator("small")).toHaveText("Paused");
  const paused = await readTimer();
  expect(paused.state).toBe("paused");
  expect(ms(paused.pause_time)).toBe(locked);
  expect(locked).toBeGreaterThan(ms(started.segment_start_time));
  // The locked baseline sent nothing: this lock's Pause is the first command after Start.
  expect(timerCommands(state).map((body) => body.action)).toEqual([
    "start",
    "pause",
  ]);
  expect(ms(timerCommands(state)[1]!.effective_time)).toBe(locked);

  // Back three minutes later: one question in the bar and in the mini timer, counted from the pause.
  await setIdleAt(page, cdp, locked + 3 * MIN, true, true);
  await expect(bar(page).locator("small")).toHaveText(
    "Away for 3 min — count it?",
  );
  await expect(
    bar(page).getByRole("button", { name: "Resume" }),
  ).toHaveCount(0);
  await expect(pip.getByRole("status")).toHaveText(
    "Away for 3 min — count it?",
  );
  await expect(pip.locator(".mini")).toHaveAttribute("data-away", "");
  // Gone again before answering: Paused while away and nothing sent; the next return asks, counted to it.
  await setIdleAt(page, cdp, locked + 4 * MIN, true, false);
  await expect(bar(page).locator("small")).toHaveText("Paused");
  await expect(pip.locator(".mini")).not.toHaveAttribute("data-away");
  expect((await readTimer()).etag).toBe(paused.etag);
  expect(timerCommands(state)).toHaveLength(2);
  await setIdleAt(page, cdp, locked + 6 * MIN, true, true);
  await expect(bar(page).locator("small")).toHaveText(
    "Away for 6 min — count it?",
  );
  await expect(pip.getByRole("status")).toHaveText(
    "Away for 6 min — count it?",
  );
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
  // Resumed at the pause: the session counts the time away, as if it never paused.
  const keep = timerCommands(state).at(-1)!;
  expect(keep.action).toBe("resume");
  expect(ms(keep.effective_time)).toBe(locked);
  expect(kept.segment_start_time).toBe(paused.pause_time);
  expect(kept.saved_seconds).toBe(paused.saved_seconds);
  expect(kept.pause_time).toBeUndefined();

  // Again, and Discard: counting resumes from the answer, so the time away counts nothing.
  const relocked = Date.now();
  await setIdleAt(page, cdp, relocked, true, false);
  await expect(bar(page).locator("small")).toHaveText("Paused");
  const second = await readTimer();
  expect(ms(second.pause_time)).toBe(relocked);
  await setIdleAt(page, cdp, relocked + 2 * MIN, true, true);
  await expect(bar(page).locator("small")).toHaveText(
    "Away for 2 min — count it?",
  );
  const answered = Date.now();
  await bar(page).getByRole("button", { name: "Discard" }).click();
  await expect(bar(page).locator("small")).toHaveText("Focus");
  const discarded = await readTimer();
  const discard = timerCommands(state).at(-1)!;
  expect(discard.action).toBe("resume");
  expect(discard.effective_time).toBeUndefined();
  expect(ms(discarded.segment_start_time)).toBeGreaterThanOrEqual(answered);
  expect(answered).toBeGreaterThan(relocked);
  expect(discarded.saved_seconds).toBe(second.saved_seconds);

  // No input for the threshold: idleness began at the last input, ten minutes before the report, which is before
  // this segment began, so Tasks moves the pause to the segment's start and the segment counts nothing.
  const reported = Date.now();
  await setIdleAt(page, cdp, reported, false, true);
  await expect(bar(page).locator("small")).toHaveText("Paused");
  const idle = await readTimer();
  const idlePause = timerCommands(state).at(-1)!;
  expect(idlePause.action).toBe("pause");
  expect(ms(idlePause.effective_time)).toBe(reported - AWAY);
  expect(reported - AWAY).toBeLessThan(ms(discarded.segment_start_time));
  expect(idle.pause_time).toBe(discarded.segment_start_time);
  expect(idle.saved_seconds).toBe(discarded.saved_seconds);
  await setIdleAt(page, cdp, reported + 4 * MIN, true, true);
  await expect(bar(page).locator("small")).toHaveText(
    "Away for 4 min — count it?",
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
  expect(await detectorReads(page)).toBeUndefined();
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
  const locked = Date.now();
  await setIdleAt(page, cdp, locked, true, false);
  await expect.poll(async () => (await readTimer()).state).toBe("paused");
  expect(ms((await readTimer()).pause_time)).toBe(locked);
  // Back: the question shows over Today, and an answer lets it go.
  await setIdleAt(page, cdp, locked + 5 * MIN, true, true);
  await expect(bar(page).locator("small")).toHaveText(
    "Away for 5 min — count it?",
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
