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

/** The task writes the host sends to the dev server's own Tasks API (estimates). */
function taskWrites(page: Page) {
  const writes: { path: string; mask: string | null; body: unknown }[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.startsWith("/api/tasks/v1/tasks/") &&
      request.method() === "PATCH"
    )
      writes.push({
        path: url.pathname,
        mask: url.searchParams.get("update_mask"),
        body: request.postDataJSON(),
      });
  });
  return writes;
}
/** Where the panel and each of its parts are, and how far it is scrolled. */
function geometry(dialog: Locator) {
  return dialog.evaluate((node) => {
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height].map(Math.round);
    };
    return {
      dialog: box(node),
      scroll: node.scrollTop,
      parts: [
        ...node.querySelectorAll(
          ".plus-native-note button, .plus-task-breadcrumb, .plus-estimate-presets > *",
        ),
      ].map(box),
    };
  });
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

test("the keyboard moves a Committed card along its row, Escape puts it back, and Down from Week commits a candidate", async ({
  page,
}) => {
  const state = await stubPlanning(page, {
    tasks: [
      outcome("parent", "Synthetic weekly outcome", { sort_order: 1 }),
      outcome("launch", "Synthetic launch", { sort_order: 2 }),
      outcome("audit", "Synthetic audit", { sort_order: 3 }),
      outcome("candidate", "Synthetic week candidate", {
        stage: "weekly",
        explicit_stage: "weekly",
      }),
    ],
  });
  await openPlan(page);
  const committed = page.getByRole("region", {
    name: "Committed",
    exact: true,
  });
  const order = () =>
    committed
      .locator(".review-draggable [data-outcome-id]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-outcome-id")),
      );
  const writes = () =>
    state.requests.filter((request) => request.method !== "GET");
  const handle = committed.getByRole("button", {
    name: /^Move outcome: Synthetic weekly outcome/u,
  });
  await expect.poll(order).toEqual(["parent", "launch", "audit"]);
  // Picked up, moved and put back with Escape: nothing changes, and focus stays.
  await handle.focus();
  await page.keyboard.press("Space");
  await expect(committed.locator(".is-dragging")).toHaveCount(1);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await expect(
    page.locator("[data-dnd-overlay][data-dnd-dragging]"),
  ).toHaveCount(0);
  await expect(handle).toBeFocused();
  expect(await order()).toEqual(["parent", "launch", "audit"]);
  expect(writes()).toEqual([]);
  // The cards sit side by side: Right two, Left one, dropped after the launch card.
  await page.keyboard.press("Space");
  await expect(committed.locator(".is-dragging")).toHaveCount(1);
  const after = committed.locator(".is-insert-after [data-outcome-id]");
  await page.keyboard.press("ArrowRight");
  await expect(after).toHaveAttribute("data-outcome-id", "launch");
  await page.keyboard.press("ArrowRight");
  await expect(after).toHaveAttribute("data-outcome-id", "audit");
  await page.keyboard.press("ArrowLeft");
  await expect(after).toHaveAttribute("data-outcome-id", "launch");
  await page.keyboard.press("Space");
  await expect.poll(order).toEqual(["launch", "parent", "audit"]);
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
  await expect(handle).toBeFocused();
  expect(bodies(state, "/api/plus/v1/tasks:reorder")).toEqual([
    expect.objectContaining({
      task_ids: ["launch", "parent", "audit"],
      lane: "committed",
    }),
  ]);
  await expect(
    page.locator("[data-dnd-overlay][data-dnd-dragging]"),
  ).toHaveCount(0);
  // Committed is the row under Week, so Down takes a Week card there: its stage.
  await page
    .getByRole("region", { name: "Week", exact: true })
    .getByRole("button", { name: "Move outcome: Synthetic week candidate" })
    .focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await expect(
    committed.locator('[data-outcome-id="candidate"]'),
  ).toBeVisible();
  await expect
    .poll(() => bodies(state, "/api/plus/v1/tasks:setTaskPlan").at(-1))
    .toMatchObject({ task_id: "candidate", stage: "committed" });
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

test("a Step's panel sets only its time in Tasks, and shows it again when reopened", async ({
  page,
  request,
}) => {
  const { id: parent } = await createTask(request, {
    title: "Synthetic outcome",
  });
  const { id: draft } = await createTask(request, {
    title: "Synthetic draft",
    kind: "step",
    parent_id: parent,
    duration_minutes: 30,
  });
  const state = await stubPlanning(page, {
    tasks: [
      outcome(parent, "Synthetic outcome"),
      { ...step(draft, "Synthetic draft", parent), estimated_minutes: 30 },
    ],
  });
  const writes = taskWrites(page);
  await openPlan(page);
  await page.getByRole("tab", { name: "Week", exact: true }).click();
  const title = page
    .getByRole("region", { name: "Next steps: Synthetic outcome" })
    .getByRole("button", { name: /^Synthetic draft/u });
  await title.click();
  const dialog = page.getByRole("dialog", { name: "Synthetic draft" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("group", { name: /^Estimate: /u })).toHaveCount(
    1,
  );
  await expect(
    dialog.getByRole("group", { name: "Estimate: Synthetic draft" }),
  ).toBeVisible();
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await expect(dialog.locator(".plus-task-breadcrumb")).toHaveText(
    "Synthetic outcome",
  );
  await expect(dialog.getByRole("button", { name: "30 min" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const firstOpen = await geometry(dialog);
  const reads = () =>
    state.requests.filter((item) => item.path === "/api/plus/v1/tasks").length;
  const readsBefore = reads();

  const sixty = dialog.getByRole("button", { name: "60 min" });
  await sixty.click();
  await expect(dialog.getByRole("status")).toHaveText("Estimate saved: 60 min");
  expect(writes).toEqual([
    {
      path: `/api/tasks/v1/tasks/${draft}`,
      mask: "duration_minutes",
      body: expect.objectContaining({ duration_minutes: 60 }),
    },
  ]);
  const saved = await (
    await request.get(`/api/tasks/v1/tasks/${draft}`)
  ).json();
  expect(saved.duration_minutes).toBe(60);
  // The saved estimate stays pressed and focused, moves nothing, and costs no planning read.
  await expect(sixty).toHaveAttribute("aria-pressed", "true");
  await expect(sixty).toBeFocused();
  expect(await geometry(dialog)).toEqual(firstOpen);
  expect(reads()).toBe(readsBefore);

  // The first Escape gives a typed value back, the next closes; focus returns to the title.
  const field = dialog.getByRole("spinbutton", { name: "Estimate" });
  await field.fill("45");
  await field.press("Escape");
  await expect(field).toHaveValue("");
  await expect(dialog).toBeVisible();
  await field.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(title).toBeFocused();
  // Reopened from the confirmed data: 60 min, with every part where it was.
  await title.click();
  await expect(sixty).toHaveAttribute("aria-pressed", "true");
  expect(await geometry(dialog)).toEqual(firstOpen);
  expect(writes).toHaveLength(1);
});

test("Add steps sends each new step with the time chosen beside it", async ({
  page,
}) => {
  const state = await stubPlanning(page, {
    tasks: [outcome("website", "Synthetic website refresh")],
  });
  await openPlan(page);
  await page.getByRole("tab", { name: "Week", exact: true }).click();
  const tray = page.getByRole("region", {
    name: "Next steps: Synthetic website refresh",
  });
  await tray
    .getByRole("button", { name: "Add steps to “Synthetic website refresh”" })
    .click();
  const input = tray.getByRole("textbox", { name: "New step" });
  const time = tray.getByRole("combobox", { name: "Estimate" });
  await expect(input).toBeFocused();
  await expect(time).toHaveValue("30");
  // One 32px row: the input, then the 76px time.
  const [field, select] = [
    (await input.boundingBox())!,
    (await time.boundingBox())!,
  ];
  expect([Math.round(select.width), Math.round(select.height)]).toEqual([
    76, 32,
  ]);
  expect(Math.round(select.y)).toBe(Math.round(field.y));
  expect(select.x).toBeGreaterThan(field.x + field.width);
  // Chosen before typing: the cell stays open.
  await time.selectOption("60");
  await expect(input).toBeVisible();
  await input.fill("Synthetic outline");
  await input.press("Enter");
  await expect
    .poll(() => bodies(state, "/api/plus/v1/tasks:appendTaskSteps"))
    .toEqual([
      {
        parent_id: "website",
        request_id: expect.any(String),
        steps: [{ title: "Synthetic outline", estimated_minutes: 60 }],
      },
    ]);
  // The read lists it as a step card with its time; the choice stays for the next.
  await expect(
    tray.getByRole("button", { name: /^Synthetic outline/u }),
  ).toContainText("1h");
  await expect(input).toBeFocused();
  await expect(time).toHaveValue("60");
  // Escape on the time closes the cell and goes back to the Add steps row; it opens again at 30.
  await time.press("Escape");
  const addSteps = tray.getByRole("button", {
    name: "Add steps to “Synthetic website refresh”",
  });
  await expect(input).toHaveCount(0);
  await expect(addSteps).toBeFocused();
  await addSteps.click();
  await expect(time).toHaveValue("30");
});

test("a double-click opens the panel: a Committed card stays selected, and the rest of a double-click never closes or writes", async ({
  page,
}) => {
  const state = await stubPlanning(page, {
    tasks: [
      outcome("launch", "Synthetic launch"),
      outcome("audit", "Synthetic audit"),
      {
        ...step("intro", "Synthetic introduction", "launch"),
        estimated_minutes: 30,
      },
      outcome("ink", "Synthetic printer ink", {
        stage: "none",
        explicit_stage: "none",
        planning_flags: ["quick"],
        area: "personal",
      }),
    ],
  });
  const writes = taskWrites(page);
  await openPlan(page);
  await page.getByRole("tab", { name: "Week", exact: true }).click();
  const grid = page.locator(".planning-commitment-grid");
  const open = page.locator("dialog.plus-dialog[open]");
  const audit = grid.getByRole("button", { name: /^Synthetic audit,/u });
  // A click selects, and a second keeps it selected.
  await audit.click();
  await audit.click();
  await expect(audit).toHaveClass(/is-selected/u);
  await expect(open).toHaveCount(0);
  await audit.dblclick();
  const panel = page.getByRole("dialog", { name: "Synthetic audit" });
  await expect(panel).toBeVisible();
  await page.waitForTimeout(300);
  await expect(panel).toBeVisible();
  await expect(audit).toHaveClass(/is-selected/u);
  await page.keyboard.press("Escape");
  await expect(open).toHaveCount(0);
  await expect(audit).toBeFocused();
  // The tray's button opens the selected commitment too, and says which.
  await page
    .getByRole("button", { name: "Steps & timing: Synthetic audit" })
    .click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");

  // Elsewhere the first click opens; the second press and click land in the dialog.
  await grid.getByRole("button", { name: /^Synthetic launch,/u }).click();
  const openers = [
    [
      page
        .getByRole("region", { name: "Next steps: Synthetic launch" })
        .getByRole("button", { name: /^Synthetic introduction/u }),
      "Synthetic introduction",
    ],
    [
      page
        .locator(".planning-quick")
        .getByRole("button", { name: /^Synthetic printer ink/u }),
      "Synthetic printer ink",
    ],
  ] as const;
  for (const [opener, name] of openers) {
    await opener.dblclick();
    const opened = page.getByRole("dialog", { name });
    await expect(opened).toBeVisible();
    await page.waitForTimeout(300);
    await expect(opened).toBeVisible();
    expect(
      await opened.evaluate((node) => node.contains(document.activeElement)),
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(open).toHaveCount(0);
    await expect(opener).toBeFocused();
  }
  await expect(
    page
      .getByRole("region", { name: "Next steps: Synthetic launch" })
      .getByRole("button", { name: /^Synthetic introduction/u }),
  ).toContainText("30m");
  expect(writes).toEqual([]);
  expect(state.requests.filter((item) => item.method !== "GET")).toEqual([]);
});
