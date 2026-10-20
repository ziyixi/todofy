import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  readFocus,
  stubPlanning,
  type Json,
  type PlanningSeed,
  type PlanningState,
} from "./planning-stub";

test.use({ serviceWorkers: "block", timezoneId: "America/Los_Angeles" });

const task = (id: string, title: string, fields: Json = {}): Json => ({
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
const step = (id: string, title: string, parent: string, order: number) =>
  task(id, title, {
    kind: "step",
    parent_id: parent,
    area: "unassigned",
    stage: "none",
    explicit_stage: "none",
    estimated_minutes: 30,
    sort_order: order,
  });
/** Three commitments with two steps, one Quick task, and a step planned on Tuesday. */
const TASKS: Json[] = [
  task("launch", "Synthetic launch", { sort_order: 1 }),
  task("audit", "Synthetic audit", { sort_order: 2 }),
  task("desk", "Synthetic desk", { area: "personal", sort_order: 3 }),
  step("intro", "Synthetic introduction", "launch", 1),
  step("layout", "Synthetic layout", "launch", 2),
  task("ink", "Synthetic printer ink", {
    stage: "none",
    explicit_stage: "none",
    planning_flags: ["quick"],
    area: "personal",
  }),
];

async function openPlan(page: Page, seed: PlanningSeed = {}) {
  await page.clock.setFixedTime(new Date("2026-10-13T18:00:00Z"));
  const state = await stubPlanning(page, {
    tasks: structuredClone(TASKS),
    // The introduction is dropped into a day, so it is one of Tasks' tasks too.
    queues: { "2026-10-13": ["layout"] },
    inTasks: ["intro"],
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
const writes = (state: PlanningState) =>
  state.requests.filter((request) => request.method !== "GET");
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
    '.planning-calendar-day[data-date="2026-10-13"] .planning-calendar-step',
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
    writes(state).map((request) => [request.path, request.body.lane]),
  ).toEqual([["/api/plus/v1/tasks:reorder", "committed"]]);
  expect(writes(state)[0]!.body.task_ids).toEqual(["launch", "desk", "audit"]);
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
  expect(writes(state).map((request) => request.body)).toEqual([
    expect.objectContaining({
      task_ids: ["audit", "launch", "desk"],
      lane: "committed",
    }),
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
  await openPlan(page);
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
  // Held for 250ms first, it drags into Wednesday.
  const wednesday = page.locator(
    '.planning-calendar-day[data-date="2026-10-14"] .planning-day-end',
  );
  await wednesday.scrollIntoViewIfNeeded();
  await title.scrollIntoViewIfNeeded();
  const from = await centre(title);
  await touch("touchStart", from.x, from.y);
  await page.waitForTimeout(350);
  await expect(page.locator(".planning-tray-step.is-dragging")).toHaveCount(1);
  const to = await centre(wednesday);
  for (let index = 1; index <= 12; index++)
    await touch(
      "touchMove",
      from.x + ((to.x - from.x) * index) / 12,
      from.y + ((to.y - from.y) * index) / 12,
    );
  await touch("touchEnd");
  await expect
    .poll(
      async () =>
        ((await readFocus("2026-10-14", "2026-10-14")).days as Json[])[0]
          ?.task_ids,
    )
    .toEqual(["intro"]);
  await expect(dragging(page)).toHaveCount(0);
});
