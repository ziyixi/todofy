import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  addDays,
  addRecord,
  otherDays,
  readFocus,
  readPlan,
  stubPlanning,
  tasksToday,
  type Json,
  type PlanningRequest,
  type PlanningState,
  type SeedTask,
} from "./planning-stub";

test.use({ serviceWorkers: "block", timezoneId: "America/Los_Angeles" });

const outcome = (
  id: string,
  title: string,
  fields: Partial<SeedTask> = {},
): SeedTask => ({ id, title, area: "work", stage: "committed", ...fields });
const step = (
  id: string,
  title: string,
  parent: string,
  fields: Partial<SeedTask> = {},
): SeedTask => ({ id, title, kind: "step", parent_id: parent, ...fields });
/** The page's writes to Tasks at `path`, its query left out. */
const sent = (state: PlanningState, path: string) =>
  state.tasksRequests.filter(
    (request) =>
      request.method !== "GET" && request.path.split("?")[0] === path,
  );
/** A request's query parameter. */
const query = (request: PlanningRequest, name: string) =>
  new URLSearchParams(request.path.split("?")[1]).get(name);
/** Every write the page sent, to Tasks or to Todofy. */
const writes = (state: PlanningState) =>
  [...state.tasksRequests, ...state.requests].filter(
    (request) => request.method !== "GET",
  );

/** Opens Plan on Tasks' today, which the page's clock is set to. */
async function openPlan(page: Page, state: PlanningState, path = "/#/plan") {
  await page.clock.setFixedTime(new Date(`${state.today}T18:00:00Z`));
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
  const week = (await readPlan()).week_start as string;
  const state = await stubPlanning(page, {
    tasks: [outcome("launch", "Synthetic launch")],
    bets: [{ week_start: week, area: "work", text: "Synthetic work line" }],
  });
  const { etag } = ((await readPlan()).weekly_bets as Json[]).find(
    (bet) => bet.name === `weeklyBets/${week}-work`,
  )!;
  await openPlan(page, state);
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
  // The masked body holds the text; the etag shown goes beside it.
  const saved = sent(state, `/api/tasks/v1/weeklyBets/${week}-work`);
  expect(
    saved.map((request) => [request.body, query(request, "etag")]),
  ).toEqual([[{ text: "Synthetic work line for review" }, etag]]);
});

test("a dependency is added in the details, and completing its prerequisite in Focus settles it", async ({
  page,
}) => {
  // Focus completes the step in Tasks' own D1, on Tasks' today.
  const venue = crypto.randomUUID();
  const call = crypto.randomUUID();
  const state = await stubPlanning(page, {
    tasks: [
      outcome("launch", "Synthetic launch"),
      outcome(venue, "Synthetic venue booking"),
      step(call, "Synthetic venue call", venue),
    ],
    queues: { [await tasksToday()]: [call] },
  });
  await openPlan(page, state);
  const dialog = await details(page, "Synthetic launch");
  const section = dialog.locator(".plus-dependencies");
  await section.getByRole("button", { name: "Add a dependency" }).click();
  const search = section.getByRole("combobox", {
    name: "Search tasks or parents",
  });
  await expect(search).toBeFocused();
  await search.fill("venue call");
  await search.press("Enter");
  // One UpdateTask of the waiting task's dependencies, the whole set.
  await expect
    .poll(() =>
      sent(state, "/api/tasks/v1/tasks/launch").map((write) => [
        query(write, "update_mask"),
        write.body,
      ]),
    )
    .toEqual([["dependencies", { dependencies: [{ prerequisite_id: call }] }]]);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  // Waiting work stays in Tasks, but is absent from Plan even when committed.
  const waiting = page.getByRole("button", {
    name: /^Synthetic launch,.*Waiting for “Synthetic venue call”/u,
  });
  await expect(waiting).toHaveCount(0);
  await expect(page.locator('[data-outcome-id="launch"]')).toHaveCount(0);

  await page.getByRole("link", { name: "Focus", exact: true }).click();
  const slot = page.locator(`.plus-focus-slot[data-task-id="${call}"]`);
  await slot
    .getByRole("button", { name: "Complete task: Synthetic venue call" })
    .click();
  await expect(
    slot.getByRole("button", { name: /^Complete task:/u }),
  ).toHaveCount(0);
  // A done prerequisite holds nothing: Plan says so with no call to Todofy, in Committed, its own lane.
  await page.getByRole("link", { name: "Plan", exact: true }).click();
  await expect(waiting).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: "Committed", exact: true })
      .getByRole("button", {
        name: /^Synthetic launch,.*Prerequisites completed$/u,
      }),
  ).toBeVisible();
  expect(state.requests).toEqual([]);
});

test("Plan's task writes read nothing first: a planning save and a dependency use successive etags", async ({
  page,
}) => {
  const state = await stubPlanning(page, {
    tasks: [
      outcome("estimated", "Synthetic estimated action"),
      outcome("awaited", "Synthetic awaited outcome"),
    ],
  });
  const answers: number[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname === "/api/tasks/v1/tasks/estimated")
      answers.push(response.status());
  });
  await openPlan(page, state);
  const dialog = await details(page, "Synthetic estimated action");
  const before = state.tasksRequests.length;
  const area = dialog.getByLabel("Work / Personal");
  await expect(area).toBeEnabled();
  await area.selectOption("personal");
  await dialog
    .locator(".plus-editor-planning")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect.poll(() => answers).toEqual([200]);
  const section = dialog.locator(".plus-dependencies");
  await section.getByRole("button", { name: "Add a dependency" }).click();
  await section
    .getByRole("combobox", { name: "Search tasks or parents" })
    .fill("awaited");
  await section
    .getByRole("combobox", { name: "Search tasks or parents" })
    .press("Enter");
  await expect.poll(() => answers).toEqual([200, 200]);
  // One UpdateTask each, and no read of the task: every answer carries the etag the next one needs.
  expect(
    state.tasksRequests
      .slice(before)
      .map((request) => [
        request.method,
        request.path.split("?")[0],
        query(request, "update_mask"),
      ]),
  ).toEqual([
    ["PATCH", "/api/tasks/v1/tasks/estimated", "area"],
    ["PATCH", "/api/tasks/v1/tasks/estimated", "dependencies"],
  ]);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("a deadline and its start-ahead days are saved in one UpdateTask", async ({
  page,
  request,
}) => {
  const state = await stubPlanning(page, {
    tasks: [outcome("report", "Synthetic report")],
  });
  const { etag } = (await (
    await request.get("/api/tasks/v1/tasks/report")
  ).json()) as Json;
  const deadline = addDays(state.today, 10);
  await openPlan(page, state);
  const dialog = await details(page, "Synthetic report");
  await dialog.getByLabel("Deadline", { exact: true }).fill(deadline);
  await dialog.getByRole("spinbutton", { name: /^Start ahead/u }).fill("3");
  await dialog
    .locator(".plus-deadline-fields")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect
    .poll(() =>
      sent(state, "/api/tasks/v1/tasks/report").map((write) => [
        query(write, "update_mask"),
        query(write, "etag"),
        write.body,
      ]),
    )
    .toEqual([["deadline,lead_days", etag, { deadline, lead_days: 3 }]]);
  await expect(
    dialog.getByRole("spinbutton", { name: /^Start ahead/u }),
  ).toHaveValue("3");
});

test("Week schedules a step into a day and moves it to another, one Tasks MoveFocusStep each", async ({
  page,
}) => {
  const intro = "intro";
  const state = await stubPlanning(page, {
    tasks: [
      outcome("website", "Synthetic website refresh"),
      step(intro, "Synthetic introduction", "website"),
    ],
  });
  // Two days of this week other than today.
  const [first, second] = otherDays(state.today) as [string, string];
  // Wide enough for all seven days side by side.
  await page.setViewportSize({ width: 1800, height: 1000 });
  await openPlan(page, state);
  await page.getByRole("tab", { name: "Week", exact: true }).click();
  const tray = page.getByRole("region", {
    name: "Next steps: Synthetic website refresh",
  });
  const thursday = page.locator(`.planning-calendar-day[data-date="${first}"]`);
  const friday = page.locator(`.planning-calendar-day[data-date="${second}"]`);
  await drag(
    page,
    tray.getByRole("button", { name: "Drag step: Synthetic introduction" }),
    thursday.locator(".planning-day-end"),
  );
  const queue = async (date: string) =>
    ((await readFocus(date, date)).days as { task_ids?: string[] }[])[0]
      ?.task_ids ?? [];
  await expect.poll(() => queue(first)).toEqual([intro]);
  await expect(page.locator(".plus-page-header .plus-spin")).toHaveCount(0);
  await drag(
    page,
    thursday.getByRole("button", {
      name: "Drag scheduled step: Synthetic introduction",
    }),
    friday.locator(".planning-day-end"),
  );
  await expect.poll(() => queue(second)).toEqual([intro]);
  expect(await queue(first)).toEqual([]);
  // The task itself is untouched: two MoveFocusStep are the only writes.
  expect(
    writes(state).map(({ path, body: { request_id: requestId, ...body } }) => {
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
      return [path, body];
    }),
  ).toEqual([
    [
      "/api/tasks/v1/focusDays:moveStep",
      { task_id: intro, destination_day: first },
    ],
    [
      "/api/tasks/v1/focusDays:moveStep",
      { task_id: intro, source_day: first, destination_day: second },
    ],
  ]);
});

test("the keyboard moves a Committed card along its row, Escape puts it back, and Down from Week commits a candidate", async ({
  page,
}) => {
  const state = await stubPlanning(page, {
    tasks: [
      outcome("parent", "Synthetic weekly outcome", { sort_order: 1 }),
      outcome("launch", "Synthetic launch", { sort_order: 2 }),
      outcome("audit", "Synthetic audit", { sort_order: 3 }),
      outcome("candidate", "Synthetic week candidate", { stage: "weekly" }),
    ],
  });
  await openPlan(page, state);
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
  expect(writes(state)).toEqual([]);
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
  expect(
    sent(state, "/api/tasks/v1/tasks:reorder").map(
      (write) => write.body.lane_order,
    ),
  ).toEqual([{ lane: "committed", task_ids: ["launch", "parent", "audit"] }]);
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
    .poll(() =>
      sent(state, "/api/tasks/v1/tasks/candidate").map((write) => [
        query(write, "update_mask"),
        write.body,
      ]),
    )
    .toEqual([["stage", { stage: "committed" }]]);
});

test("the weekly review link opens the checklist once and clears its parameter", async ({
  page,
}) => {
  const state = await stubPlanning(page, {
    tasks: [outcome("launch", "Synthetic launch")],
  });
  await openPlan(page, state, "/?review=1#/plan");
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
  const parent = crypto.randomUUID();
  const draft = crypto.randomUUID();
  const state = await stubPlanning(page, {
    tasks: [
      outcome(parent, "Synthetic outcome"),
      step(draft, "Synthetic draft", parent, { duration_minutes: 30 }),
    ],
  });
  const writes = taskWrites(page);
  await openPlan(page, state);
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
  // Plan's reads: GetPlan and its list of open tasks.
  const reads = () =>
    state.tasksRequests.filter(
      (item) =>
        item.method === "GET" &&
        (item.path === "/api/tasks/v1/plan" ||
          item.path.startsWith("/api/tasks/v1/tasks?view=all&page_size")),
    ).length;
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
  const website = crypto.randomUUID();
  const state = await stubPlanning(page, {
    tasks: [outcome(website, "Synthetic website refresh")],
  });
  await openPlan(page, state);
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
  // One CreateTask: a step under the outcome, its time its duration.
  await expect
    .poll(() => sent(state, "/api/tasks/v1/tasks").map((write) => write.body))
    .toEqual([
      {
        title: "Synthetic outline",
        parent_id: website,
        kind: "step",
        duration_minutes: 60,
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

test("Plan deletes a Step inline, removes its queue row and preserves its recorded time", async ({
  page,
  request,
}, testInfo) => {
  const parent = crypto.randomUUID();
  const draft = crypto.randomUUID();
  const title = "Synthetic step to delete";
  const today = await tasksToday();
  const state = await stubPlanning(page, {
    tasks: [
      outcome(parent, "Synthetic deletion outcome"),
      step(draft, title, parent, { duration_minutes: 30 }),
    ],
    queues: { [today]: [draft] },
  });
  await addRecord(draft, today, 15, "work");
  const before = await readFocus(today, today);
  expect(before.entries).toHaveLength(1);
  const original = await (
    await request.get(`/api/tasks/v1/tasks/${draft}`)
  ).json();
  await page.setViewportSize({ width: 1800, height: 1000 });
  await openPlan(page, state);
  await page.getByRole("tab", { name: "Week", exact: true }).click();
  const day = page.locator(`.planning-calendar-day[data-date="${today}"]`);
  const card = day.locator(`[data-task-id="${draft}"]`);
  const plannedStep = page.locator(`.planning-week [data-task-id="${draft}"]`);
  await expect(card).toHaveCount(1);
  await card.getByRole("button", { name: title, exact: true }).click();
  const panel = page.getByRole("dialog", { name: title, exact: true });
  await expect(panel.locator(".plus-step-editor")).toBeVisible();
  await panel.getByRole("button", { name: "Delete step", exact: true }).click();
  const confirmation = panel.getByRole("group", { name: "Delete step" });
  await expect(confirmation).toContainText(`Delete “${title}”?`);
  await expect(
    confirmation.getByRole("button", { name: "Cancel" }),
  ).toBeFocused();
  await expect(page.locator(".task-dialog")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("plan-step-delete-confirmation.png"),
  });
  const deleted = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname === `/api/tasks/v1/tasks/${draft}`,
  );
  await confirmation
    .getByRole("button", { name: "Delete", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  expect((await deleted).status()).toBe(200);
  await expect(panel).toBeHidden();
  await expect(card).toHaveCount(0);
  await expect(plannedStep).toHaveCount(0);
  expect((await request.get(`/api/tasks/v1/tasks/${draft}`)).status()).toBe(
    404,
  );
  const after = await readFocus(today, today);
  expect((after.days as Json[])[0]?.task_ids ?? []).not.toContain(draft);
  expect((after.days as Json[])[0]?.done_task_ids ?? []).not.toContain(draft);
  expect(after.entries).toEqual(before.entries);
  const changes = writes(state);
  expect(changes).toHaveLength(1);
  expect(changes[0]).toMatchObject({
    method: "DELETE",
    path: expect.stringContaining(`/api/tasks/v1/tasks/${draft}?`),
  });
  expect(query(changes[0]!, "etag")).toBe(original.etag);
  expect(query(changes[0]!, "request_id")).toMatch(/^[0-9a-f-]{36}$/u);
  await expect(page.locator(".task-dialog")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("plan-step-deleted-time-preserved.png"),
  });
});

test("Week hides Quick tasks before their Deadline start window and keeps ready or undated tasks", async ({
  page,
}, testInfo) => {
  const today = await tasksToday();
  const quick = (title: string, fields: Partial<SeedTask> = {}) =>
    outcome(crypto.randomUUID(), title, {
      stage: "none",
      planning_flags: ["quick"],
      ...fields,
    });
  const state = await stubPlanning(page, {
    tasks: [
      quick("Synthetic quick future", {
        deadline: addDays(today, 8),
        lead_days: 7,
      }),
      quick("Synthetic quick ready", {
        deadline: addDays(today, 7),
        lead_days: 7,
      }),
      quick("Synthetic quick undated"),
    ],
  });
  await openPlan(page, state);
  await page.getByRole("tab", { name: "Week", exact: true }).click();
  const tray = page.getByRole("region", { name: "Quick tasks", exact: true });
  await expect(tray.locator(".planning-quick-card")).toHaveCount(2);
  await expect(
    tray.getByRole("button", { name: /^Synthetic quick future,/u }),
  ).toHaveCount(0);
  await expect(
    tray.getByRole("button", { name: /^Synthetic quick ready,/u }),
  ).toBeVisible();
  await expect(
    tray.getByRole("button", { name: /^Synthetic quick undated,/u }),
  ).toBeVisible();
  expect(writes(state)).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("plan-quick-deadline-window.png"),
  });
});

test("a double-click opens the panel: a Committed card stays selected, and the rest of a double-click never closes or writes", async ({
  page,
}) => {
  const state = await stubPlanning(page, {
    tasks: [
      outcome("launch", "Synthetic launch"),
      outcome("audit", "Synthetic audit"),
      step("intro", "Synthetic introduction", "launch", {
        duration_minutes: 30,
      }),
      outcome("ink", "Synthetic printer ink", {
        stage: "none",
        planning_flags: ["quick"],
        area: "personal",
      }),
    ],
  });
  const patches = taskWrites(page);
  await openPlan(page, state);
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
  expect(patches).toEqual([]);
  expect(writes(state)).toEqual([]);
});
