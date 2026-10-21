import { expect, test, type Locator } from "@playwright/test";
import {
  planReads,
  readFocus,
  readTimer,
  readTodofy,
  stubPlanning,
  tasksToday,
  type PlanningRequest,
  type PlanningState,
  type SeedTask,
} from "./planning-stub";

test.use({ serviceWorkers: "block", timezoneId: "America/Los_Angeles" });

/** The page's writes to a task in Tasks, as [update_mask, body]. */
const taskWrites = (state: PlanningState, id: string) =>
  state.tasksRequests
    .filter(
      (request) =>
        request.method === "PATCH" &&
        request.path.split("?")[0] === `/api/tasks/v1/tasks/${id}`,
    )
    .map((request: PlanningRequest) => [
      new URLSearchParams(request.path.split("?")[1]).get("update_mask"),
      request.body,
    ]);

test("a native lane reorder keeps its siblings pending and the next stage drag saves on its first attempt", async ({
  page,
  request,
}) => {
  const outcome = (id: string, title: string, order: number): SeedTask => ({
    id,
    title,
    area: "work",
    stage: "weekly",
    sort_order: order,
  });
  const state = await stubPlanning(page, {
    tasks: [
      outcome("native-first", "Synthetic first outcome", 1),
      outcome("native-second", "Synthetic second outcome", 2),
    ],
    laneOrders: [
      { lane: "weekly", task_ids: ["native-first", "native-second"] },
    ],
  });
  let releaseReorder: (() => void) | undefined;
  const heldReorder = new Promise<void>((resolve) => {
    releaseReorder = resolve;
  });
  await page.route("**/api/tasks/v1/tasks:reorder", async (route) => {
    expect(route.request().postDataJSON().lane_order).toEqual({
      lane: "weekly",
      task_ids: ["native-second", "native-first"],
    });
    await heldReorder;
    await route.continue();
  });
  async function drag(source: Locator, target: Locator) {
    await expect(
      page.locator("[data-dnd-overlay][data-dnd-dragging]"),
    ).toHaveCount(0);
    const from = (await source.boundingBox())!;
    const to = (await target.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      from.x + from.width / 2 + 8,
      from.y + from.height / 2,
      {
        steps: 3,
      },
    );
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, {
      steps: 18,
    });
    await page.mouse.up();
  }
  await page.clock.setFixedTime(new Date(`${state.today}T18:00:00Z`));
  await page.goto("/#/plan");
  const week = page.getByRole("region", { name: "Week", exact: true });
  const month = page.getByRole("region", { name: "Month", exact: true });
  const firstHandle = page.getByRole("button", {
    name: /^Move outcome: Synthetic first outcome/u,
  });
  const secondHandle = page.getByRole("button", {
    name: /^Move outcome: Synthetic second outcome/u,
  });
  await expect(firstHandle).toBeVisible();
  await expect(page.locator("[data-dnd-overlay]").first()).toHaveCSS(
    "pointer-events",
    "none",
  );
  const firstCard = week.locator('[data-outcome-id="native-first"]');
  await drag(secondHandle, firstCard);
  await expect(week.locator('.review-draggable[aria-busy="true"]')).toHaveCount(
    2,
  );
  await expect(firstHandle).toHaveAttribute("aria-disabled", "true");
  await expect(secondHandle).toHaveAttribute("aria-disabled", "true");
  releaseReorder!();
  await expect(week.locator(".review-draggable.is-pending")).toHaveCount(0);
  // The card's title text, not the full-title bubble that repeats it for sight.
  await expect(
    week.locator(".planning-outcome-title .planning-full-title-text"),
  ).toHaveText(["Synthetic second outcome", "Synthetic first outcome"]);
  // The reorder's answer replaced both tasks: no read, and the next write is over the new etag.
  expect(planReads(state)).toBe(1);
  const { etag } = await (
    await request.get("/api/tasks/v1/tasks/native-first")
  ).json();
  await drag(firstHandle, month);
  await expect(month.locator('[data-outcome-id="native-first"]')).toBeVisible();
  await expect(month.locator(".review-draggable.is-pending")).toHaveCount(0);
  const stageWrites = () =>
    state.tasksRequests.filter(
      (write) =>
        write.method === "PATCH" &&
        write.path.startsWith("/api/tasks/v1/tasks/native-first?"),
    );
  expect(taskWrites(state, "native-first")).toEqual([
    ["stage", { stage: "monthly" }],
  ]);
  expect(
    new URLSearchParams(stageWrites()[0]!.path.split("?")[1]).get("etag"),
  ).toBe(etag);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(month.locator('[data-outcome-id="native-first"]')).toBeVisible();
  await expect(week.locator('[data-outcome-id="native-second"]')).toBeVisible();
  expect(stageWrites()).toHaveLength(1);
});

test("native Plan, Focus timer and Mail use the owner transport without an extension connection", async ({
  page,
}) => {
  // Focus is on Tasks' today, by the dev server's real clock.
  const today = await tasksToday();
  const outcomeId = crypto.randomUUID();
  const stepId = crypto.randomUUID();
  const mailId = crypto.randomUUID();
  const state = await stubPlanning(page, {
    tasks: [
      {
        id: outcomeId,
        title: "Synthetic native weekly outcome",
        area: "work",
        stage: "committed",
      },
      {
        id: stepId,
        kind: "step",
        title: "Synthetic native next step",
        parent_id: outcomeId,
      },
    ],
    queues: { [today]: [stepId] },
    mail: [
      {
        id: mailId,
        title: "Synthetic native mail",
        summary: "Synthetic native summary",
        receivedAt: Date.parse("2026-10-13T17:00:00Z"),
      },
    ],
  });
  await page.goto("/#/plan");
  await expect(
    page.getByText("Synthetic native weekly outcome", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: /api key|token|connection/i }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Planning labels", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Choose a label for this column", { exact: true }),
  ).toHaveCount(0);
  const handle = page.getByRole("button", {
    name: "Move outcome: Synthetic native weekly outcome",
    exact: true,
  });
  const month = page.getByRole("region", { name: "Month", exact: true });
  const source = (await handle.boundingBox())!;
  const target = (await month.boundingBox())!;
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
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
    { steps: 18 },
  );
  await page.mouse.up();
  const moved = month.getByRole("button", {
    name: /^Synthetic native weekly outcome,/u,
  });
  await expect(moved).toBeVisible();
  // Dragging updates the card before the queued mutation reaches the transport.
  await expect
    .poll(() => taskWrites(state, outcomeId)[0])
    .toEqual(["stage", { stage: "monthly" }]);
  await moved.click();
  const details = page.getByRole("dialog");
  await details.getByText("Task options", { exact: true }).click();
  await details
    .getByRole("checkbox", { name: "Quick action", exact: true })
    .click();
  await expect(
    details.getByRole("checkbox", { name: "Quick action", exact: true }),
  ).toBeChecked();
  await expect
    .poll(() => taskWrites(state, outcomeId)[1])
    .toEqual(["planning_flags", { planning_flags: ["quick"] }]);
  await details.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Planning settings", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Focus", exact: true }).click();
  const step = page.locator(`.plus-focus-slot[data-task-id="${stepId}"]`);
  await expect(step).toContainText("Synthetic native next step");
  await expect(step).toContainText("Synthetic native weekly outcome");
  await step
    .getByRole("button", {
      name: "Start: Synthetic native next step",
      exact: true,
    })
    .click();
  await expect(
    step.getByRole("button", {
      name: "Pause: Synthetic native next step",
      exact: true,
    }),
  ).toBeVisible();
  const command = state.tasksRequests.find(
    (request) => request.path === "/api/tasks/v1/focusTimer:command",
  );
  expect(command?.body).toMatchObject({
    action: "start",
    task_id: stepId,
  });
  await step
    .getByRole("button", {
      name: "Pause: Synthetic native next step",
      exact: true,
    })
    .click();
  await expect(
    step.getByRole("button", {
      name: "Resume: Synthetic native next step",
      exact: true,
    }),
  ).toBeVisible();
  await step
    .getByRole("button", {
      name: "Complete task: Synthetic native next step",
      exact: true,
    })
    .click();
  // The completion's re-read no longer lists the task.
  await expect(
    step.getByRole("button", { name: /^Complete task:/u }),
  ).toHaveCount(0);
  await expect(page.locator(".plus-page-header .plus-spin")).toHaveCount(0);
  // One Tasks write completes the step on Focus's day and settles its paused session.
  expect(
    state.tasksRequests
      .filter((request) => request.path.endsWith(":complete"))
      .map((request) => [request.path, request.body.focus_day]),
  ).toEqual([[`/api/tasks/v1/tasks/${stepId}:complete`, today]]);
  const day = (await readFocus(today, today)).days as {
    task_ids?: string[];
    done_task_ids?: string[];
  }[];
  expect(day[0]?.task_ids ?? []).not.toContain(stepId);
  expect(day[0]?.done_task_ids).toContain(stepId);
  expect((await readTimer()).state).toBe("idle");
  // Plan and Focus write only to Tasks: Todofy has heard nothing yet.
  expect(state.requests).toEqual([]);
  expect(taskWrites(state, outcomeId)).toHaveLength(2);
  const mailStart = state.requests.length;
  await page.getByRole("link", { name: "Mail", exact: true }).click();
  await page.getByText("Synthetic native mail", { exact: true }).click();
  await expect(
    page.getByText("Synthetic native summary", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(
    page.getByText("No mail to review", { exact: true }),
  ).toBeVisible();
  const conversions = state.requests.filter(
    (request) => request.path === "/api/tasks/v1/mailItems:convert",
  );
  expect(conversions).toHaveLength(1);
  expect(conversions[0]!.body).toMatchObject({ event_id: mailId });
  expect(conversions[0]!.body).not.toHaveProperty("task_id");
  expect(
    state.requests
      .slice(mailStart)
      .map((request) => request.path.split("?")[0]),
  ).toEqual([
    "/api/mail/v1/mailItems",
    `/api/mail/v1/mailItems/${mailId}`,
    "/api/tasks/v1/mailItems:convert",
  ]);
  // Tasks made the task and marked the mail in Todofy.
  const [converted] = (await readTodofy()).mail;
  expect(converted).toMatchObject({ id: mailId, pending: false });
  expect(converted?.taskId).toBeTruthy();
  expect(
    state.requests.every((request) => request.authorization === null),
  ).toBe(true);
  expect(
    state.requests.some((request) => request.path.includes("connections")),
  ).toBe(false);
});
