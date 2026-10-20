import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  otherDays,
  readFocus,
  stubPlanning,
  tasksToday,
  type Json,
  type PlanningSeed,
  type PlanningState,
  type SeedTask,
} from "./planning-stub";

test.use({ serviceWorkers: "block", timezoneId: "America/Los_Angeles" });

const task = (
  id: string,
  title: string,
  fields: Partial<SeedTask> = {},
): SeedTask => ({ id, title, area: "work", stage: "committed", ...fields });
const step = (id: string, title: string, parent: string, order: number) =>
  task(id, title, {
    kind: "step",
    parent_id: parent,
    area: "unassigned",
    stage: "none",
    duration_minutes: 30,
    sort_order: order,
  });
/** Three commitments with two steps, one Quick task, and a step planned on Tasks' today. */
const TASKS: SeedTask[] = [
  task("launch", "Synthetic launch", { sort_order: 1 }),
  task("audit", "Synthetic audit", { sort_order: 2 }),
  task("desk", "Synthetic desk", { area: "personal", sort_order: 3 }),
  step("intro", "Synthetic introduction", "launch", 1),
  step("layout", "Synthetic layout", "launch", 2),
  task("ink", "Synthetic printer ink", {
    stage: "none",
    planning_flags: ["quick"],
    area: "personal",
  }),
];

/** Plan on Tasks' today, by the dev server's clock, which the page's clock is set to. */
async function openPlan(page: Page, seed: PlanningSeed = {}) {
  const today = await tasksToday();
  await page.clock.setFixedTime(new Date(`${today}T18:00:00Z`));
  const state = await stubPlanning(page, {
    tasks: TASKS,
    queues: { [today]: ["layout"] },
    ...seed,
  });
  await page.goto("/#/plan");
  await expect(
    page.getByRole("region", { name: "Weekly goals" }),
  ).toBeVisible();
  return state;
}
const week = (page: Page) =>
  page.getByRole("tab", { name: "Week", exact: true }).click();
/** Every write the page sent, to Tasks or to Todofy. */
const writes = (state: PlanningState) =>
  [...state.tasksRequests, ...state.requests].filter(
    (request) => request.method !== "GET",
  );
const dragging = (page: Page) =>
  page.locator("[data-dnd-overlay][data-dnd-dragging]");
/** The middle of an element, in the page's coordinates. */
async function centre(locator: Locator) {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
/** Presses the mouse on `body` and moves it `distance` px to the right, without letting go. */
async function pressAndMove(page: Page, body: Locator, distance = 8) {
  await expect(dragging(page)).toHaveCount(0);
  await body.scrollIntoViewIfNeeded();
  const { x, y } = await centre(body);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + distance, y, { steps: 4 });
}
/** The CSS opacity of an element. */
const opacity = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).opacity);
const left = async (locator: Locator) => (await locator.boundingBox())!.x;

/** A press on `body` that moves 8px drags `row`; Escape puts it back. */
async function dragsByBody(page: Page, body: Locator, row: Locator) {
  await pressAndMove(page, body);
  await expect(row).toHaveClass(/is-dragging/u);
  await expect(dragging(page)).toHaveCount(1);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(dragging(page)).toHaveCount(0);
  await expect(row).not.toHaveClass(/is-dragging/u);
}

test("every Plan card drags by its body after 8px, and Escape puts it back", async ({
  page,
}) => {
  const state = await openPlan(page);
  const committed = page.getByRole("region", {
    name: "Committed",
    exact: true,
  });
  await dragsByBody(
    page,
    committed.getByRole("button", { name: /^Synthetic audit,/u }),
    committed.locator(".review-draggable").nth(1),
  );
  await week(page);
  const grid = page.locator(".planning-commitment-grid");
  await dragsByBody(
    page,
    grid.getByRole("button", { name: /^Synthetic audit,/u }),
    grid.locator(".planning-commitment").nth(1),
  );
  const tray = page.locator('.planning-tray-step[data-task-id="intro"]');
  await dragsByBody(page, tray.locator(".planning-step-title"), tray);
  const quick = page.locator(".planning-quick-card");
  await dragsByBody(page, quick.locator(".planning-quick-title"), quick);
  // The meta line under the title: the card's body, no control at all.
  const calendar = page.locator(
    `.planning-calendar-day[data-date="${state.today}"] .planning-calendar-step`,
  );
  await dragsByBody(
    page,
    calendar.locator(".planning-calendar-step-meta"),
    calendar,
  );
  // A press on complete or remove that moves never drags, nor does it click.
  for (const control of [
    tray.getByRole("button", { name: /^Complete task/u }),
    calendar.getByRole("button", { name: /^Remove from/u }),
  ]) {
    await pressAndMove(page, control, 12);
    await page.waitForTimeout(100);
    await expect(dragging(page)).toHaveCount(0);
    await page.mouse.up();
  }
  expect(writes(state)).toEqual([]);
});

test("one Week commitment selects on a click, opens on a double-click and moves on a drag", async ({
  page,
}) => {
  const state = await openPlan(page);
  await week(page);
  const grid = page.locator(".planning-commitment-grid");
  const card = (title: string) =>
    grid.getByRole("button", { name: new RegExp(`^${title},`, "u") });
  const order = () =>
    grid
      .locator(".planning-outcome-card")
      .evaluateAll((cards) =>
        cards.map((item) => item.getAttribute("data-outcome-id")),
      );
  const audit = card("Synthetic audit");
  await audit.click();
  await expect(audit).toHaveClass(/is-selected/u);
  await audit.dblclick();
  const panel = page.getByRole("dialog", { name: "Synthetic audit" });
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(audit).toHaveClass(/is-selected/u);
  expect(writes(state)).toEqual([]);
  // Dragged by its title onto the desk's card, it takes the desk's place.
  const before = state.tasksRequests.length;
  await pressAndMove(page, audit);
  await expect(grid.locator(".planning-commitment.is-dragging")).toHaveCount(1);
  const desk = await centre(card("Synthetic desk"));
  await page.mouse.move(desk.x, desk.y, { steps: 12 });
  await expect(
    grid.locator(".planning-commitment.is-insert-after [data-outcome-id]"),
  ).toHaveAttribute("data-outcome-id", "desk");
  await page.mouse.up();
  await expect.poll(order).toEqual(["launch", "desk", "audit"]);
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
  expect(
    writes(state).map((request) => [request.path, request.body.lane_order]),
  ).toEqual([
    [
      "/api/tasks/v1/tasks:reorder",
      { lane: "committed", task_ids: ["launch", "desk", "audit"] },
    ],
  ]);
  // Nothing is read first: the positions go under the etags Plan holds.
  expect(
    state.tasksRequests
      .slice(before)
      .map((request) => `${request.method} ${request.path}`),
  ).toEqual(["POST /api/tasks/v1/tasks:reorder"]);
  // The drop was no click: the selection and the dialog are as they were.
  await expect(audit).toHaveClass(/is-selected/u);
  await expect(page.locator("dialog.plus-dialog[open]")).toHaveCount(0);
});

test("the keyboard moves a Week commitment from its grip, and focus stays on that grip", async ({
  page,
}) => {
  const state = await openPlan(page);
  await week(page);
  const grid = page.locator(".planning-commitment-grid");
  const grip = grid.getByRole("button", {
    name: "Move commitment: Synthetic launch",
  });
  await grip.focus();
  await page.keyboard.press("Space");
  await expect(grid.locator(".is-dragging")).toHaveCount(1);
  await page.keyboard.press("ArrowRight");
  await expect(
    grid.locator(".is-insert-after [data-outcome-id]"),
  ).toHaveAttribute("data-outcome-id", "audit");
  await page.keyboard.press("Space");
  await expect
    .poll(() =>
      grid
        .locator(".planning-outcome-card")
        .evaluateAll((cards) =>
          cards.map((item) => item.getAttribute("data-outcome-id")),
        ),
    )
    .toEqual(["audit", "launch", "desk"]);
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
  await expect(grip).toBeFocused();
  expect(writes(state).map((request) => request.body.lane_order)).toEqual([
    { lane: "committed", task_ids: ["audit", "launch", "desk"] },
  ]);
  // A reload reads the saved order back.
  await page.reload();
  await week(page);
  await expect(grid.locator(".planning-outcome-card").first()).toHaveAttribute(
    "data-outcome-id",
    "audit",
  );
});

test("a click still opens a card's panel and a double-click too, with no drag", async ({
  page,
}) => {
  const state = await openPlan(page);
  const open = page.locator("dialog.plus-dialog[open]");
  await page
    .getByRole("region", { name: "Committed", exact: true })
    .getByRole("button", { name: /^Synthetic desk,/u })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Synthetic desk" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(open).toHaveCount(0);
  await week(page);
  const calendarTitle = page
    .locator('.planning-calendar-step[data-task-id="layout"]')
    .getByRole("button", { name: "Synthetic layout", exact: true });
  for (const open of [
    () => calendarTitle.click(),
    () => calendarTitle.dblclick(),
  ]) {
    await open();
    await expect(
      page.getByRole("dialog", { name: "Synthetic layout" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog.plus-dialog[open]")).toHaveCount(0);
  }
  await expect(dragging(page)).toHaveCount(0);
  expect(writes(state)).toEqual([]);
});

test("small cards' grips show only on hover, and their titles never move", async ({
  page,
}) => {
  await openPlan(page);
  await week(page);
  await page.mouse.move(0, 0);
  const cards = [
    page.locator('.planning-tray-step[data-task-id="intro"]'),
    page.locator(".planning-quick-card"),
    page.locator('.planning-calendar-step[data-task-id="layout"]'),
  ];
  for (const card of cards) {
    const grip = card.locator(".planning-drag-handle");
    const title = card.locator(".planning-step-title, .planning-quick-title");
    expect(await opacity(grip)).toBe("0");
    const before = await left(title);
    await card.hover();
    await expect.poll(() => opacity(grip)).toBe("1");
    expect(await left(title)).toBe(before);
    // The grip sits in the card's left padding, before the title.
    expect((await grip.boundingBox())!.x).toBeLessThan(before);
    await page.mouse.move(0, 0);
    await expect.poll(() => opacity(grip)).toBe("0");
  }
  // Keyboard focus shows a grip too (Tab from the tray's heading button onto the first step's
  // grip); Review's outcome grips always show.
  const grip = cards[0]!.locator(".planning-drag-handle");
  await page
    .getByRole("button", { name: "Steps & timing: Synthetic launch" })
    .focus();
  await page.keyboard.press("Tab");
  await expect(grip).toBeFocused();
  expect(await grip.evaluate((node) => node.matches(":focus-visible"))).toBe(
    true,
  );
  await expect.poll(() => opacity(grip)).toBe("1");
  expect(
    await opacity(
      page.locator(".planning-commitment .review-drag-handle").first(),
    ),
  ).toBe("1");
});

test("on touch a card drags after a 250ms hold, and a quick swipe on it scrolls instead", async ({
  page,
}) => {
  const { today } = await openPlan(page);
  const [day] = otherDays(today) as [string];
  await week(page);
  // Playwright has no touch drag: Chromium's own touch input, through the DevTools protocol.
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", x = 0, y = 0) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x, y }],
    });
  const title = page
    .getByRole("region", { name: "Next steps: Synthetic launch" })
    .getByRole("button", { name: /^Synthetic introduction/u });
  // A quick swipe up from the card scrolls the page and drags nothing.
  const start = await centre(title);
  await touch("touchStart", start.x, start.y);
  for (let moved = 20; moved <= 160; moved += 20)
    await touch("touchMove", start.x, start.y - moved);
  await touch("touchEnd");
  await expect
    .poll(async () => (await title.boundingBox())!.y)
    .toBeLessThan(start.y - 40);
  await expect(dragging(page)).toHaveCount(0);
  await expect(page.locator(".planning-tray-step.is-dragging")).toHaveCount(0);
  // Held for 250ms first, it drags into that day.
  const target = page.locator(
    `.planning-calendar-day[data-date="${day}"] .planning-day-end`,
  );
  await target.scrollIntoViewIfNeeded();
  await title.scrollIntoViewIfNeeded();
  const from = await centre(title);
  await touch("touchStart", from.x, from.y);
  await page.waitForTimeout(350);
  await expect(page.locator(".planning-tray-step.is-dragging")).toHaveCount(1);
  const to = await centre(target);
  for (let index = 1; index <= 12; index++)
    await touch(
      "touchMove",
      from.x + ((to.x - from.x) * index) / 12,
      from.y + ((to.y - from.y) * index) / 12,
    );
  await touch("touchEnd");
  await expect
    .poll(async () => ((await readFocus(day, day)).days as Json[])[0]?.task_ids)
    .toEqual(["intro"]);
  await expect(dragging(page)).toHaveCount(0);
});

test("today's Focus steps drag by their whole row: one MoveFocusStep, kept after a reload, never from the records", async ({
  page,
}) => {
  // Focus is on Tasks' own today in the dev server's D1, so this page keeps the real clock.
  const today = await tasksToday();
  const state = await stubPlanning(page, {
    tasks: TASKS,
    queues: { [today]: ["intro", "layout", "ink"] },
  });
  await page.goto("/#/focus");
  const order = () =>
    page
      .locator('[aria-label="Today\'s steps"] > .plus-focus-slot')
      .evaluateAll((slots) =>
        slots.map((slot) => slot.getAttribute("data-task-id")),
      );
  await expect.poll(order).toEqual(["intro", "layout", "ink"]);
  const slot = (id: string) =>
    page.locator(`.plus-focus-slot[data-task-id="${id}"]`);
  // Pressed on its title and moved, the ink takes the introduction's place.
  await pressAndMove(page, slot("ink").locator(".plus-focus-title"));
  await expect(slot("ink")).toHaveClass(/is-dragging/u);
  const intro = await centre(slot("intro"));
  await page.mouse.move(intro.x, intro.y, { steps: 12 });
  await expect(slot("intro")).toHaveClass(/is-insert-before/u);
  await page.mouse.up();
  await expect.poll(order).toEqual(["ink", "intro", "layout"]);
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
  const moves = state.tasksRequests.filter(
    (request) => request.path === "/api/tasks/v1/focusDays:moveStep",
  );
  expect(
    moves.map(({ body: { request_id: requestId, ...body } }) => {
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
      return body;
    }),
  ).toEqual([
    {
      task_id: "ink",
      source_day: today,
      destination_day: today,
      before_task_id: "intro",
    },
  ]);
  expect(writes(state)).toEqual(moves);
  expect(((await readFocus(today, today)).days as Json[])[0]?.task_ids).toEqual(
    ["ink", "intro", "layout"],
  );
  await page.reload();
  await expect.poll(order).toEqual(["ink", "intro", "layout"]);
  // Its grip drags it too, and the preview is as wide as its row, under the pointer.
  const grip = slot("layout").locator(".plus-focus-grip");
  await slot("layout").hover();
  await pressAndMove(page, grip.locator("svg"));
  await expect(slot("layout")).toHaveClass(/is-dragging/u);
  const row = (await slot("layout").boundingBox())!;
  const preview = (await page.locator(".plus-focus-overlay").boundingBox())!;
  expect(Math.abs(preview.width - row.width)).toBeLessThan(2);
  const pointer = await centre(grip);
  expect(pointer.x + 8).toBeGreaterThan(preview.x);
  expect(pointer.x + 8).toBeLessThan(preview.x + preview.width);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(dragging(page)).toHaveCount(0);
  await expect.poll(order).toEqual(["ink", "intro", "layout"]);
  // A press inside a card's records that moves never drags the card.
  await slot("layout")
    .getByRole("button", { name: /^Log time/u })
    .click();
  const records = page.getByRole("dialog");
  await pressAndMove(page, records.getByRole("heading"), 12);
  await page.waitForTimeout(100);
  await expect(dragging(page)).toHaveCount(0);
  await expect(slot("layout")).not.toHaveClass(/is-dragging/u);
  await page.mouse.up();
  await expect(records).toBeVisible();
  expect(
    state.tasksRequests.filter(
      (request) => request.path === "/api/tasks/v1/focusDays:moveStep",
    ),
  ).toHaveLength(1);
});
