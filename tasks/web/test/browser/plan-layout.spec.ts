import { expect, test, type Locator, type Page } from "@playwright/test";
import { stubPlanning, type Json } from "./planning-stub";

test.use({ serviceWorkers: "block", timezoneId: "America/Los_Angeles" });

/** The widths Plan is checked at: the owner's 1440 window down to the narrow board. */
const WIDTHS = [1440, 1024, 800, 680] as const;

const task = (id: string, title: string, fields: Json = {}): Json => ({
  id,
  kind: "task",
  title,
  area: "work",
  stage: "none",
  explicit_stage: "none",
  planning_flags: [],
  etag: "1",
  priority: 1,
  ...fields,
});
const committed = (id: string, title: string, area: string, fields = {}) =>
  task(id, title, {
    area,
    stage: "committed",
    explicit_stage: "committed",
    ...fields,
  });
const step = (
  id: string,
  title: string,
  parent: string,
  minutes: number | undefined,
  order: number,
): Json => ({
  ...task(id, title, { kind: "step", parent_id: parent, area: "unassigned" }),
  sort_order: order,
  ...(minutes === undefined ? {} : { estimated_minutes: minutes }),
});
const quick = (id: string, title: string, area = "personal") =>
  task(id, title, { planning_flags: ["quick"], area });

const LONG_STEP =
  `Write the migration plan for moving the day queues and the time records into the Tasks database ${"and check every step again ".repeat(8)}`
    .trim()
    .slice(0, 300);
const URL_STEP = `https://example.test/${"synthetic-path/".repeat(13)}`.slice(
  0,
  200,
);
const LONG_QUICK =
  "Pay the electricity bill before Friday so that autopay does not bounce again";
const LONG_OUTCOME =
  "Migrate day queues off FlowDay and into Tasks D1 without losing the week's arrangement";

/** Eleven commitments (Work, Personal and one Unassigned), six Review lanes and a long Quick list. */
const TASKS: Json[] = [
  committed("w1", "Ship native Focus time ledger", "work", { priority: 4 }),
  committed("w2", "Q4 roadmap review", "work", { priority: 3 }),
  committed("w3", LONG_OUTCOME, "work"),
  committed("w4", "Hire: second interview loop", "work"),
  // Work P3: its slate edge sits next to the blue P3 flag.
  committed("w5", "Fix flaky CI", "work", { priority: 2 }),
  committed("w6", "Write the performance pass design doc for Tasks", "work"),
  committed("p1", "Renew passport", "personal"),
  committed(
    "p2",
    "Plan the Kyoto trip with flights and the itinerary",
    "personal",
  ),
  committed("p3", "Dentist", "personal"),
  committed("p4", "Garage cleanup", "personal"),
  committed("u1", "Sort the shared photo archive", "unassigned"),
  step("s1", "Draft API", "w1", 30, 1),
  step("s2", LONG_STEP, "w1", 60, 2),
  step("s3", "Review", "w1", 15, 3),
  step("s4", URL_STEP, "w1", 45, 4),
  step("s5", "Prototype the per-step time entry editor", "w1", 150, 5),
  step("s6", "Tests", "w1", undefined, 6),
  step("s7", "Inventory the photo folders", "u1", 30, 1),
  quick("q1", "Reply to Alex", "work"),
  quick("q2", LONG_QUICK),
  quick("q3", "Order printer ink"),
  quick("q4", "File the expense report", "work"),
  quick("q5", "Email the landlord about the window latch"),
  quick("q6", "Renew library card"),
  // The last chip in the row, by the window's right edge.
  quick("q7", "Call the bank about the duplicated card payment from the trip"),
  quick("q8", "Water the plants"),
  task("qa", "Learn Rust for Workers", {
    stage: "quarterly",
    explicit_stage: "quarterly",
  }),
  task("ma", "Photo book 2026", {
    area: "personal",
    stage: "monthly",
    explicit_stage: "monthly",
  }),
  task("wk", "Call grandma", {
    area: "personal",
    stage: "weekly",
    explicit_stage: "weekly",
  }),
  // Two waiting tasks whose statuses have two parts, the deadline first, and a parked one: with
  // them Review has six lanes, five columns at 1440.
  task("venue", "Hear back about the venue quote", {
    planning_flags: ["waiting"],
    deadline: "2026-10-22",
    update_time: "2026-09-20T16:00:00Z",
  }),
  task("visa", "Lab access approval", {
    planning_flags: ["waiting"],
    deadline: "2026-10-11",
    update_time: "2026-09-25T16:00:00Z",
  }),
  task("piano", "Learn piano", {
    area: "personal",
    planning_flags: ["parked"],
    update_time: "2026-08-20T16:00:00Z",
  }),
];

async function openPlan(page: Page, width: number) {
  await page.clock.setFixedTime(new Date("2026-10-13T18:00:00Z"));
  await page.setViewportSize({ width, height: 900 });
  await stubPlanning(page, {
    tasks: TASKS,
    days: {
      "2026-10-12": ["s7"],
      "2026-10-13": ["s1", "s3", "q1"],
      "2026-10-14": ["s5"],
    },
  });
  await page.goto("/#/plan");
  await expect(
    page.getByRole("region", { name: "Weekly goals" }),
  ).toBeVisible();
}
const week = (page: Page) =>
  page.getByRole("tab", { name: "Week", exact: true });

/** Rounded bounding sizes of every element a selector matches. */
function boxes(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return {
        width: Math.round(box.width),
        height: Math.round(box.height),
        top: Math.round(box.top),
      };
    }),
  );
}
function borderLeft(locator: Locator) {
  return locator.evaluate(
    (element) => getComputedStyle(element).borderLeftColor,
  );
}
/** What a colour token resolves to inside the planning UI. */
function token(page: Page, name: string) {
  return page.locator(".planning-ui").evaluate((root, name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    root.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, name);
}
/** Hovers a title's host for longer than the bubble's wait. */
async function hover(page: Page, host: Locator) {
  await host.hover();
  await page.waitForTimeout(400);
}
function bubble(host: Locator) {
  return host.locator(".planning-full-title-bubble");
}

for (const width of WIDTHS)
  test(`outcome cards are one height with a left-aligned line at ${width}px`, async ({
    page,
  }, testInfo) => {
    await openPlan(page, width);
    await expect(page.locator(".review-board")).toBeVisible();
    for (const view of ["review", "week"] as const) {
      if (view === "week") await week(page).click();
      const cards =
        view === "review"
          ? ".review-board .planning-outcome-card"
          : ".planning-commitment-grid .planning-outcome-card";
      await expect(page.locator(cards).first()).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`plan-${view}-${width}.png`),
        fullPage: true,
      });
      for (const card of await boxes(page, cards))
        expect(Math.abs(card.height - 77)).toBeLessThanOrEqual(1);
      // The meta line is left-aligned and never wraps or overflows.
      const meta = await page
        .locator(".planning-outcome-counts, .planning-outcome-status")
        .evaluateAll((elements) =>
          elements.map((element) => ({
            align: getComputedStyle(element).textAlign,
            counts: element.classList.contains("planning-outcome-counts"),
            overflows: element.scrollWidth > element.clientWidth,
          })),
        );
      expect(meta.length).toBeGreaterThan(0);
      expect(
        meta.filter((line) => !["left", "start"].includes(line.align)),
      ).toEqual([]);
      expect(meta.filter((line) => line.counts && line.overflows)).toEqual([]);
    }
    // Every commitment shows, each card at least 220px wide.
    const commitments = await boxes(page, ".planning-commitment");
    expect(commitments).toHaveLength(11);
    expect(commitments.filter((card) => card.width < 220)).toEqual([]);
    if (width === 1440)
      expect(new Set(commitments.map((card) => card.top)).size).toBe(3);
  });

test("a two-part status puts its deadline first, on one line", async ({
  page,
}) => {
  await openPlan(page, 1440);
  const waiting = page.getByRole("region", { name: "Waiting" });
  const status = (title: string) =>
    waiting
      .getByRole("button", { name: new RegExp(`^${title},`, "u") })
      .locator(".planning-outcome-status");
  await expect(status("Hear back about the venue quote")).toHaveText(
    /^Deadline Oct 22 · No change in \d+ days$/u,
  );
  await expect(status("Lab access approval")).toHaveText(
    /^2 days late · No change in \d+ days$/u,
  );
  await expect(
    page
      .getByRole("region", { name: "Parked" })
      .locator(".planning-outcome-status"),
  ).toHaveText(/^No change in \d+ days$/u);
  // The area is in the name and the colour, not a word on the card.
  await expect(page.locator(".planning-outcome-context")).toHaveCount(0);
  await expect(
    waiting.getByRole("button", {
      name: /^Hear back about the venue quote, Work, No priority, /u,
    }),
  ).toBeVisible();
});

test("a cut outcome title shows in full on hover, and a title that fits never does", async ({
  page,
}) => {
  await openPlan(page, 1440);
  await week(page).click();
  const long = page.locator(
    '.planning-commitment .planning-outcome-card[data-outcome-id="w3"]',
  );
  await expect(long.locator(".planning-outcome-title")).not.toHaveAttribute(
    "title",
  );
  await hover(page, long);
  await expect(bubble(long)).toBeVisible({ timeout: 100 });
  await expect(bubble(long)).toHaveText(LONG_OUTCOME);
  const short = page.locator(
    '.planning-commitment .planning-outcome-card[data-outcome-id="p3"]',
  );
  await hover(page, short);
  await expect(bubble(short)).toBeHidden();
  await expect(bubble(long)).toBeHidden();
});

for (const width of WIDTHS)
  test(`Next steps and Quick cards keep their sizes at ${width}px`, async ({
    page,
  }) => {
    await openPlan(page, width);
    await week(page).click();
    const steps = await boxes(
      page,
      ".planning-tray-steps > .planning-tray-step",
    );
    expect(steps).toHaveLength(6);
    for (const card of steps)
      expect(Math.abs(card.height - 60)).toBeLessThanOrEqual(1);
    // A 300-character title and a 200-character URL do not widen their cards.
    expect(new Set(steps.map((card) => card.width)).size).toBe(1);
    const overflowing = await page
      .locator(".planning-tray-step")
      .evaluateAll(
        (cards) =>
          cards.filter((card) => card.scrollWidth > card.clientWidth).length,
      );
    expect(overflowing).toBe(0);
    // Two hours or more: the estimate is in the warning colour, and no sentence says so.
    const long = page.locator(
      '.planning-tray-step[data-task-id="s5"] .planning-step-long',
    );
    await expect(long).toHaveText("2h 30m");
    expect(
      await long.evaluate((element) => getComputedStyle(element).color),
    ).toBe(await token(page, "--plus-warning"));
    await expect(page.locator(".planning-step-warning")).toHaveCount(0);
    // Quick chips share one width; at the owner's width the six shown share one row.
    const chips = await boxes(page, ".planning-quick-card");
    expect(chips).toHaveLength(6);
    expect(new Set(chips.map((chip) => chip.width)).size).toBe(1);
    if (width === 1440)
      expect(new Set(chips.map((chip) => chip.top)).size).toBe(1);
    // "1 more" follows the heading's count instead of taking a cell.
    await expect(
      page
        .locator(".planning-quick-heading")
        .getByRole("button", { name: "1 more" }),
    ).toBeVisible();
  });

test("a cut Next step or Quick title floats in full on hover and on keyboard focus", async ({
  page,
}, testInfo) => {
  await openPlan(page, 1440);
  await week(page).click();
  const title = (id: string) =>
    page.locator(
      `.planning-tray-step[data-task-id="${id}"] .planning-step-title`,
    );
  await hover(page, title("s2"));
  await expect(bubble(title("s2"))).toBeVisible({ timeout: 100 });
  await expect(bubble(title("s2"))).toHaveText(LONG_STEP);
  // The window only: an element shot may scroll, which would move the hover.
  await page.screenshot({
    path: testInfo.outputPath("plan-week-bubble-1440.png"),
  });
  await hover(page, title("s4"));
  await expect(bubble(title("s4"))).toBeVisible({ timeout: 100 });
  await expect(bubble(title("s2"))).toBeHidden();
  // A title that fits never shows one.
  await hover(page, title("s1"));
  await expect(bubble(title("s1"))).toBeHidden();
  // Keyboard: Tab from the step's handle onto its title.
  await page.mouse.move(0, 0);
  await page
    .locator('.planning-tray-step[data-task-id="s2"] .planning-drag-handle')
    .focus();
  await page.keyboard.press("Tab");
  await expect(title("s2")).toBeFocused();
  await page.waitForTimeout(400);
  await expect(bubble(title("s2"))).toBeVisible({ timeout: 100 });
  // The button's name is the whole title; the bubble is for sight only.
  await expect(title("s2")).toHaveAccessibleName(
    new RegExp(`^${LONG_STEP.slice(0, 40)}`, "u"),
  );

  const chip = page
    .locator(".planning-quick-card")
    .filter({ hasText: LONG_QUICK })
    .first();
  const quickTitle = chip.locator(".planning-quick-title");
  await expect(quickTitle).not.toHaveAttribute("title");
  await expect(quickTitle).toHaveAccessibleName(`${LONG_QUICK}, Personal`);
  await hover(page, quickTitle);
  await expect(bubble(quickTitle)).toBeVisible({ timeout: 100 });
  await expect(bubble(quickTitle)).toHaveText(LONG_QUICK);
  await page.mouse.move(0, 0);
  await chip.locator(".planning-drag-handle").focus();
  await page.keyboard.press("Tab");
  await expect(quickTitle).toBeFocused();
  await page.waitForTimeout(400);
  await expect(bubble(quickTitle)).toBeVisible({ timeout: 100 });
  // By the window's right edge the bubble opens leftwards: it stays in the window, and the page
  // never scrolls sideways.
  const last = page
    .locator(".planning-quick-card .planning-quick-title")
    .last();
  await expect(last).toHaveAccessibleName(/^Call the bank about/u);
  await hover(page, last);
  await expect(bubble(last)).toBeVisible({ timeout: 100 });
  const right = await bubble(last).evaluate(
    (element) => element.getBoundingClientRect().right,
  );
  expect(right).toBeLessThanOrEqual(1440 - 16);
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    ),
  ).toBe(0);
});

test("every Plan card's left edge is its area's colour", async ({
  page,
}, testInfo) => {
  await openPlan(page, 1440);
  const work = await token(page, "--plus-area-work");
  const personal = await token(page, "--plus-area-personal");
  const none = await token(page, "--plus-line");
  expect(work).toBe("rgb(99, 135, 163)");
  expect(personal).toBe("rgb(169, 131, 105)");
  const outcome = (id: string, scope = ".review-board") =>
    page.locator(`${scope} .planning-outcome-card[data-outcome-id="${id}"]`);
  expect(await borderLeft(outcome("w5"))).toBe(work);
  expect(await borderLeft(outcome("p1"))).toBe(personal);
  expect(await borderLeft(outcome("u1"))).toBe(none);
  await week(page).click();
  const selected = page.locator(
    ".planning-commitment .planning-outcome-card.is-selected",
  );
  await expect(selected).toHaveAttribute("data-outcome-id", "w1");
  expect(await borderLeft(selected)).toBe(work);
  expect(await borderLeft(outcome("p2", ".planning-commitment-grid"))).toBe(
    personal,
  );
  expect(await borderLeft(outcome("u1", ".planning-commitment-grid"))).toBe(
    none,
  );
  expect(
    await borderLeft(page.locator('.planning-tray-step[data-task-id="s1"]')),
  ).toBe(work);
  expect(
    await borderLeft(
      page.locator(".planning-quick-card").filter({ hasText: LONG_QUICK }),
    ),
  ).toBe(personal);
  expect(
    await borderLeft(
      page.locator('.planning-calendar-step[data-task-id="s1"]'),
    ),
  ).toBe(work);
  // A step inherits its outcome's area: here, none.
  expect(
    await borderLeft(
      page.locator('.planning-calendar-step[data-task-id="s7"]'),
    ),
  ).toBe(none);
  // The legend: Work and Personal's dots, none for All or Unassigned.
  const dots = await page
    .locator(".planning-week .planning-area-filter button")
    .evaluateAll((buttons) =>
      buttons.map((button) => [
        button.textContent,
        getComputedStyle(button, "::before").backgroundColor,
      ]),
    );
  expect(dots).toEqual([
    ["All", "rgba(0, 0, 0, 0)"],
    ["Work", work],
    ["Personal", personal],
    ["Unassigned", "rgba(0, 0, 0, 0)"],
  ]);
  await page.locator(".planning-week").screenshot({
    path: testInfo.outputPath("plan-week-colours-1440.png"),
  });
});
