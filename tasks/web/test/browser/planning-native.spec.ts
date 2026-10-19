import { expect, test, type Locator } from "@playwright/test";
import { createTask, flowdayTaskWrites, stubPlanning } from "./planning-stub";

test.use({ serviceWorkers: "block", timezoneId: "America/Los_Angeles" });

test("a native lane reorder keeps its siblings pending and the next stage drag saves on its first attempt", async ({
  page,
}) => {
  const tasks = [
    { id: "native-first", title: "Synthetic first outcome", sort_order: 1 },
    { id: "native-second", title: "Synthetic second outcome", sort_order: 2 },
  ].map((task) => ({
    ...task,
    kind: "task",
    project_id: "inbox",
    area: "work",
    stage: "weekly",
    explicit_stage: "weekly",
    etag: "1",
  }));
  let laneOrder = tasks.map((task) => task.id);
  let releaseReorder: (() => void) | undefined;
  const heldReorder = new Promise<void>((resolve) => {
    releaseReorder = resolve;
  });
  const stageWrites: Record<string, unknown>[] = [];
  let taskReads = 0;
  await page.route("**/api/plus/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/plus/v1/plan:read") {
      await route.fulfill({
        json: {
          plan: {
            timezone: "America/Los_Angeles",
            week_start: "2026-10-12",
            today: "2026-10-13",
            enabled: true,
            native_planning: true,
            etag: "native-plan",
            lane_orders: [{ lane: "weekly", task_ids: laneOrder }],
          },
        },
      });
      return;
    }
    if (path === "/api/plus/v1/tasks") {
      taskReads++;
      await route.fulfill({ json: { planning_tasks: tasks } });
      return;
    }
    if (path === "/api/plus/v1/tasks:reorder") {
      const body = route.request().postDataJSON();
      expect(body.task_ids).toEqual(["native-second", "native-first"]);
      laneOrder = body.task_ids;
      for (const task of tasks) {
        task.sort_order = laneOrder.indexOf(task.id) + 1;
        task.etag = "2";
      }
      await heldReorder;
      await route.fulfill({
        json: {
          tasks,
          lane_order: { lane: "weekly", task_ids: laneOrder },
        },
      });
      return;
    }
    if (path === "/api/plus/v1/tasks:setTaskPlan") {
      const body = route.request().postDataJSON();
      stageWrites.push(body);
      const task = tasks.find((task) => task.id === body.task_id)!;
      if (body.etag !== task.etag) {
        await route.fulfill({
          status: 409,
          json: {
            error: {
              status: "ABORTED",
              message: "Synthetic task changed",
            },
          },
        });
        return;
      }
      task.stage = body.stage;
      task.explicit_stage = body.stage;
      task.etag = "3";
      await route.fulfill({ json: { task } });
      return;
    }
    if (path === "/api/plus/flowday/api/v1/tasks") {
      await route.fulfill({ json: { tasks: [] } });
      return;
    }
    if (path.startsWith("/api/plus/flowday/api/v1/flows/")) {
      await route.fulfill({
        json: { name: path.slice("/api/plus/flowday/api/v1/".length) },
      });
      return;
    }
    if (path === "/api/plus/flowday/api/v1/timerSession") {
      await route.fulfill({
        json: { name: "timerSession", state: "idle", etag: "0" },
      });
      return;
    }
    throw new Error(`Unexpected synthetic request ${path}`);
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
  await page.clock.setFixedTime(new Date("2026-10-13T18:00:00Z"));
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
  await expect(week.locator(".planning-outcome-title")).toHaveText([
    "Synthetic second outcome",
    "Synthetic first outcome",
  ]);
  expect(taskReads).toBe(1);
  await drag(firstHandle, month);
  await expect(month.locator('[data-outcome-id="native-first"]')).toBeVisible();
  await expect(month.locator(".review-draggable.is-pending")).toHaveCount(0);
  expect(stageWrites).toHaveLength(1);
  expect(stageWrites[0]).toMatchObject({
    task_id: "native-first",
    etag: "2",
    stage: "monthly",
  });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.reload();
  await expect(month.locator('[data-outcome-id="native-first"]')).toBeVisible();
  await expect(week.locator('[data-outcome-id="native-second"]')).toBeVisible();
  expect(stageWrites).toHaveLength(1);
});

test("native Plan, Focus timer and Mail use the owner transport without an extension connection", async ({
  page,
  request,
}) => {
  const today = "2026-10-13";
  // Focus completes the step in Tasks' own D1 before it settles FlowDay through Todofy.
  const { id: outcomeId } = await createTask(request, {
    title: "Synthetic native weekly outcome",
  });
  const { id: stepId } = await createTask(request, {
    title: "Synthetic native next step",
    kind: "step",
    parent_id: outcomeId,
  });
  const tasks: Record<string, unknown>[] = [
    {
      id: outcomeId,
      kind: "task",
      title: "Synthetic native weekly outcome",
      area: "work",
      stage: "committed",
      explicit_stage: "committed",
      labels: ["ordinary"],
      planning_flags: [],
      etag: "1",
    },
    {
      id: stepId,
      kind: "step",
      title: "Synthetic native next step",
      parent_id: outcomeId,
      area: "unassigned",
      stage: "none",
      explicit_stage: "none",
      planning_flags: [],
      etag: "1",
    },
  ];
  const state = await stubPlanning(page, {
    today,
    tasks,
    flowTasks: [
      {
        name: `tasks/${stepId}`,
        todoist_id: stepId,
        title: tasks[1]!.title,
        estimated_minutes: 30,
      },
    ],
    days: { [today]: [stepId] },
    mail: [
      {
        id: "native-message",
        title: "Synthetic native mail",
        etag: "mail-1",
        receive_time: "2026-10-13T17:00:00Z",
        brief: "Synthetic native brief",
        has_summary: true,
      },
    ],
    summaries: { "native-message": "Synthetic native summary" },
  });
  const writes = () =>
    state.requests
      .filter((request) => request.path === "/api/plus/v1/tasks:setTaskPlan")
      .map((request) => request.body);
  await page.clock.setFixedTime(new Date("2026-10-13T18:00:00Z"));
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
  await expect(
    month.getByText("Synthetic native weekly outcome", { exact: true }),
  ).toBeVisible();
  // Dragging updates the card before the queued mutation reaches the transport.
  await expect
    .poll(() => writes()[0])
    .toMatchObject({
      task_id: outcomeId,
      stage: "monthly",
    });
  expect(tasks[0]!.labels).toEqual(["ordinary"]);
  await month
    .getByText("Synthetic native weekly outcome", { exact: true })
    .click();
  const details = page.getByRole("dialog");
  await details.getByText("Task options", { exact: true }).click();
  await details
    .getByRole("checkbox", { name: "Quick action", exact: true })
    .click();
  await expect(
    details.getByRole("checkbox", { name: "Quick action", exact: true }),
  ).toBeChecked();
  await expect
    .poll(() => writes()[1])
    .toMatchObject({ task_id: outcomeId, quick: true });
  expect(writes()[1]).not.toHaveProperty("labels");
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
  const command = state.requests.find((request) =>
    request.path.endsWith("/timerSession:command"),
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
  expect(
    state.requests.filter(
      (request) => request.path === "/api/plus/v1/tasks:completeTask",
    ),
  ).toHaveLength(1);
  // Focus writes the timer and completes through Tasks; FlowDay's own task API stays untouched.
  expect(flowdayTaskWrites(state)).toEqual([]);
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
    (request) => request.path === "/api/plus/v1/mailItems:convertMailItem",
  );
  expect(conversions).toHaveLength(1);
  expect(conversions[0]!.body).toMatchObject({
    event_id: "native-message",
    etag: "mail-1",
  });
  expect(conversions[0]!.body).not.toHaveProperty("task_id");
  expect(
    state.requests.slice(mailStart).map((request) => request.path),
  ).toEqual([
    "/api/plus/v1/mailItems",
    "/api/plus/v1/mailItems:readMailSummary",
    "/api/plus/v1/mailItems:convertMailItem",
  ]);
  expect(
    state.requests.every((request) => request.authorization === null),
  ).toBe(true);
  expect(
    state.requests.some((request) => request.path.includes("connections")),
  ).toBe(false);
});
