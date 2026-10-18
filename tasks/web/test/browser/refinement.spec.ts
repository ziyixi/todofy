import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

test.use({ serviceWorkers: "block", timezoneId: "America/Los_Angeles" });

interface SavedTask {
  id: string;
  title: string;
  etag: string;
  kind?: string;
  effort?: string;
  parent_id?: string;
  due_date?: string;
  due_datetime?: string;
  due_timezone?: string;
  deadline?: string;
  recurrence?: string;
  duration_minutes?: number;
}
interface SavedPlanning {
  stage: string;
  area: string;
  flags: Set<string>;
  leadDays: number;
  revision: number;
}
async function createTask(
  request: APIRequestContext,
  title: string,
  fields: Record<string, unknown> = {},
): Promise<SavedTask> {
  const csrf = await request.get("/api/tasks/csrf");
  const { token } = await csrf.json();
  const response = await request.post(
    `/api/tasks/v1/tasks?request_id=${crypto.randomUUID()}`,
    {
      headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
      data: { title, ...fields },
    },
  );
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
async function savedTask(
  request: APIRequestContext,
  id: string,
): Promise<SavedTask> {
  const response = await request.get(`/api/tasks/v1/tasks/${id}`);
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}

/** Only the planning service is synthetic. Task reads, saves, child writes and deletes reach real D1. */
async function planningService(page: Page, request: APIRequestContext) {
  const state = new Map<string, SavedPlanning>();
  let dependencies: {
    task_id: string;
    prerequisite_id: string;
    baseline_completed_count: number;
    done: boolean;
  }[] = [];
  function planningState(id: string) {
    let value = state.get(id);
    if (!value) {
      value = {
        stage: "none",
        area: "unassigned",
        flags: new Set(),
        leadDays: 0,
        revision: 1,
      };
      state.set(id, value);
    }
    return value;
  }
  async function projection(id: string) {
    const task = await savedTask(request, id);
    const value = planningState(id);
    return {
      id,
      title: task.title,
      parent_id: task.parent_id || "",
      kind: task.kind || "task",
      effort: task.effort || "",
      area: value.area,
      stage: value.stage,
      explicit_stage: value.stage,
      planning_flags: [...value.flags],
      lead_days: value.leadDays,
      deadline: task.deadline || "",
      etag: `synthetic-planning-${value.revision}`,
    };
  }
  await page.route("**/api/plus/**", async (route) => {
    const url = new URL(route.request().url());
    let body: unknown;
    if (url.pathname === "/api/plus/v1/plan:read") {
      body = {
        plan: {
          timezone: "America/Los_Angeles",
          week_start: "2030-01-07",
          today: "2030-01-07",
          enabled: true,
          native_planning: true,
          etag: "synthetic-plan",
          dependencies,
        },
      };
    } else if (url.pathname === "/api/plus/v1/tasks") {
      const ids = url.searchParams.getAll("task_ids");
      if (!ids.length) {
        const response = await request.get(
          "/api/tasks/v1/tasks?view=all&page_size=100",
        );
        const data = (await response.json()) as { tasks?: SavedTask[] };
        ids.push(...(data.tasks || []).map((task) => task.id));
      }
      body = { planning_tasks: await Promise.all(ids.map(projection)) };
    } else if (url.pathname === "/api/plus/v1/tasks:setTaskPlan") {
      const input = route.request().postDataJSON() as Record<string, unknown>;
      const id = String(input.task_id);
      const value = planningState(id);
      expect(input.etag).toBe(`synthetic-planning-${value.revision}`);
      if (input.stage !== undefined) value.stage = String(input.stage);
      if (input.area !== undefined) value.area = String(input.area);
      for (const [field, flag] of [
        ["single_action", "task"],
        ["quick", "quick"],
        ["active", "active"],
        ["waiting", "waiting"],
        ["on_hold", "onhold"],
        ["routine", "routine"],
        ["parked", "parked"],
      ] as const) {
        if (input[field] === true) value.flags.add(flag);
        if (input[field] === false) value.flags.delete(flag);
      }
      value.revision += 1;
      body = { task: await projection(id) };
    } else if (url.pathname === "/api/plus/v1/tasks:setTaskDependency") {
      const input = route.request().postDataJSON() as {
        task_id: string;
        prerequisite_id: string;
        waits?: boolean;
      };
      dependencies = dependencies.filter(
        (edge) =>
          edge.task_id !== input.task_id ||
          edge.prerequisite_id !== input.prerequisite_id,
      );
      if (input.waits)
        dependencies.push({
          task_id: input.task_id,
          prerequisite_id: input.prerequisite_id,
          baseline_completed_count: 0,
          done: false,
        });
      body = { dependencies };
    } else if (url.pathname === "/api/plus/v1/tasks:setTaskLead") {
      const input = route.request().postDataJSON() as {
        task_id: string;
        etag: string;
        deadline: string;
        lead_days?: number;
      };
      const value = planningState(input.task_id);
      expect(input.etag).toBe(`synthetic-planning-${value.revision}`);
      expect(input.deadline).toBe(
        (await savedTask(request, input.task_id)).deadline,
      );
      value.leadDays = input.lead_days || 0;
      value.revision += 1;
      body = { task: await projection(input.task_id) };
    } else {
      await route.fulfill({
        status: 500,
        json: {
          error: {
            message: `Unexpected synthetic planning request: ${url.pathname}`,
          },
        },
      });
      return;
    }
    await route.fulfill({ json: body });
  });
  return state;
}

async function openTask(page: Page, id: string, kind = "task") {
  await page.goto(`/?task=${id}#/inbox`);
  const dialog = page.getByRole("dialog", {
    name: kind === "step" ? "Step details" : "Task details",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  if (kind !== "step")
    await expect(
      dialog.getByRole("combobox", { name: "Planning stage", exact: true }),
    ).toBeEnabled();
  return dialog;
}

test("parent editors keep subtasks and executable steps separate and can delete either inline", async ({
  page,
  request,
}) => {
  await planningService(page, request);
  const parent = await createTask(
    request,
    `Synthetic grouped outcome ${crypto.randomUUID()}`,
  );
  const dialog = await openTask(page, parent.id);
  const subtaskTitle = "Synthetic child outcome";
  const stepTitle = "Synthetic small executable step";
  await dialog
    .getByRole("textbox", { name: "New subtask", exact: true })
    .fill(subtaskTitle);
  await dialog
    .getByRole("textbox", { name: "New subtask", exact: true })
    .press("Enter");
  const subtasks = dialog.getByRole("region", {
    name: "Subtasks",
    exact: true,
  });
  const steps = dialog.getByRole("region", { name: "Steps", exact: true });
  await expect(
    subtasks.getByRole("button", { name: subtaskTitle, exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("group", { name: "Add a child", exact: true })
    .getByRole("button", { name: "Step", exact: true })
    .click();
  await dialog
    .getByRole("combobox", { name: "Step estimate", exact: true })
    .selectOption("45");
  await dialog
    .getByRole("textbox", { name: "New step", exact: true })
    .fill(stepTitle);
  await dialog
    .getByRole("textbox", { name: "New step", exact: true })
    .press("Enter");
  await expect(
    steps.getByRole("button", { name: stepTitle, exact: true }),
  ).toBeVisible();
  await expect(steps).toContainText("45m");
  const list = await request.get(
    `/api/tasks/v1/tasks?parent_id=${parent.id}&include_completed=true`,
  );
  const { tasks } = (await list.json()) as { tasks: SavedTask[] };
  const child = tasks.find((task) => task.title === subtaskTitle)!;
  const step = tasks.find((task) => task.title === stepTitle)!;
  expect(child.kind).toBe("task");
  expect(child.duration_minutes || 0).toBe(0);
  expect(step.kind).toBe("step");
  expect(step.duration_minutes).toBe(45);
  await page.reload();
  await expect(
    subtasks.getByRole("button", { name: subtaskTitle, exact: true }),
  ).toBeVisible();
  await expect(
    steps.getByRole("button", { name: stepTitle, exact: true }),
  ).toBeVisible();
  await subtasks
    .getByRole("button", {
      name: `Delete subtask ${subtaskTitle}`,
      exact: true,
    })
    .click();
  await subtasks
    .getByRole("alert")
    .getByRole("button", { name: "Delete subtask", exact: true })
    .click();
  await expect(
    subtasks.getByRole("button", { name: subtaskTitle, exact: true }),
  ).toHaveCount(0);
  expect((await request.get(`/api/tasks/v1/tasks/${child.id}`)).status()).toBe(
    404,
  );
  expect((await savedTask(request, step.id)).parent_id).toBe(parent.id);
  await steps
    .getByRole("button", { name: `Delete step ${stepTitle}`, exact: true })
    .click();
  await steps
    .getByRole("alert")
    .getByRole("button", { name: "Delete step", exact: true })
    .click();
  await expect(
    steps.getByRole("button", { name: stepTitle, exact: true }),
  ).toHaveCount(0);
  expect((await request.get(`/api/tasks/v1/tasks/${step.id}`)).status()).toBe(
    404,
  );
  expect((await savedTask(request, parent.id)).title).toBe(parent.title);
  await page.reload();
  await expect(
    subtasks.getByRole("button", { name: subtaskTitle, exact: true }),
  ).toHaveCount(0);
  await expect(
    steps.getByRole("button", { name: stepTitle, exact: true }),
  ).toHaveCount(0);
});

test("ordinary task planning, effort and deadline lead are visible and survive saving and reopening", async ({
  page,
  request,
}) => {
  const planning = await planningService(page, request);
  const task = await createTask(
    request,
    `Synthetic visible planning ${crypto.randomUUID()}`,
    { deadline: "2030-02-28" },
  );
  const dialog = await openTask(page, task.id);
  await expect(dialog.getByText("More details", { exact: true })).toHaveCount(
    0,
  );
  await dialog
    .getByRole("combobox", { name: "Planning stage", exact: true })
    .selectOption("committed");
  await dialog
    .getByRole("combobox", { name: "Task context", exact: true })
    .selectOption("work");
  await dialog
    .getByRole("checkbox", { name: "Standalone action", exact: true })
    .check();
  await dialog
    .getByRole("combobox", { name: "Effort", exact: true })
    .selectOption("deep");
  await dialog
    .getByRole("spinbutton", { name: "Start ahead amount", exact: true })
    .fill("2");
  await dialog
    .getByRole("combobox", { name: "Start ahead unit", exact: true })
    .selectOption("weeks");
  await expect(
    dialog.getByRole("checkbox", { name: "Blocked", exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.locator(".task-save-status")).toHaveText("Saved");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const saved = await savedTask(request, task.id);
  expect(saved.effort).toBe("deep");
  expect(saved.deadline).toBe("2030-02-28");
  expect(planning.get(task.id)).toMatchObject({
    stage: "committed",
    area: "work",
    leadDays: 14,
  });
  expect(planning.get(task.id)!.flags.has("task")).toBe(true);
  await page.reload();
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Planning stage", exact: true }),
  ).toHaveValue("committed");
  await expect(
    dialog.getByRole("combobox", { name: "Task context", exact: true }),
  ).toHaveValue("work");
  await expect(
    dialog.getByRole("checkbox", { name: "Standalone action", exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("combobox", { name: "Effort", exact: true }),
  ).toHaveValue("deep");
  await expect(
    dialog.getByRole("spinbutton", { name: "Start ahead amount", exact: true }),
  ).toHaveValue("2");
  await expect(
    dialog.getByRole("combobox", { name: "Start ahead unit", exact: true }),
  ).toHaveValue("weeks");
});

test("repeat controls save calendar rules while only steps expose a clock time", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1080, height: 900 });
  await planningService(page, request);
  const task = await createTask(
    request,
    `Synthetic calendar recurrence ${crypto.randomUUID()}`,
    { due_date: "2030-01-02" },
  );
  const dialog = await openTask(page, task.id);
  const date = dialog.getByRole("button", { name: "Date", exact: true });
  await date.click();
  await expect(dialog.getByLabel("Time", { exact: true })).toHaveCount(0);
  await expect(
    dialog.getByRole("button", { name: "Time options", exact: true }),
  ).toHaveCount(0);
  const repeatOptions = dialog.getByRole("button", {
    name: "Repeat options",
    exact: true,
  });
  await expect(repeatOptions).toHaveAttribute("aria-expanded", "false");
  await expect(repeatOptions).toHaveText("Repeat");
  await expect(
    dialog.getByRole("combobox", { name: "Repeat", exact: true }),
  ).toHaveCount(0);
  await repeatOptions.click();
  await dialog
    .getByRole("combobox", { name: "Repeat", exact: true })
    .selectOption("weekly");
  const completionAnchor = dialog.getByRole("checkbox", {
    name: "Count from completion",
    exact: true,
  });
  await expect(completionAnchor).toBeVisible();
  for (const weekday of [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ]) {
    await expect(
      dialog.getByRole("checkbox", { name: weekday, exact: true }),
    ).toBeVisible();
  }
  for (const selector of [
    ".schedule-popup",
    ".repeat-days",
    ".repeat-anchor",
  ]) {
    const bounds = await dialog.locator(selector).evaluate((element) => ({
      width: element.clientWidth,
      contentWidth: element.scrollWidth,
    }));
    expect(bounds.width, selector).toBeGreaterThan(0);
    expect(bounds.contentWidth, selector).toBeLessThanOrEqual(bounds.width);
  }

  await dialog
    .getByRole("spinbutton", { name: "Repeat interval", exact: true })
    .fill("2");
  await dialog.getByRole("checkbox", { name: "Monday", exact: true }).check();
  await dialog.getByRole("checkbox", { name: "Friday", exact: true }).check();
  await dialog
    .getByRole("checkbox", { name: "Wednesday", exact: true })
    .uncheck();
  await date.click();
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.locator(".task-save-status")).toHaveText("Saved");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect((await savedTask(request, task.id)).recurrence).toBe(
    "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR",
  );
  await page.reload();
  await expect(dialog).toBeVisible();
  await date.click();
  await expect(repeatOptions).toHaveAttribute("aria-expanded", "false");
  await expect(repeatOptions).toHaveText("Every 2 weeks");
  await expect(
    dialog.getByRole("combobox", { name: "Repeat", exact: true }),
  ).toHaveCount(0);
  await repeatOptions.click();
  await expect(
    dialog.getByRole("combobox", { name: "Repeat", exact: true }),
  ).toHaveValue("weekly");
  await expect(
    dialog.getByRole("spinbutton", { name: "Repeat interval", exact: true }),
  ).toHaveValue("2");
  await expect(
    dialog.getByRole("checkbox", { name: "Monday", exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("checkbox", { name: "Friday", exact: true }),
  ).toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "Count from completion", exact: true })
    .check();
  await expect(
    dialog.getByRole("checkbox", { name: "Monday", exact: true }),
  ).toHaveCount(0);
  await date.click();
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.locator(".task-save-status")).toHaveText("Saved");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect((await savedTask(request, task.id)).recurrence).toBe("every! 2 weeks");
  await page.reload();
  await date.click();
  await expect(repeatOptions).toHaveText("Every 2 weeks · after completion");
  await repeatOptions.click();
  await expect(
    dialog.getByRole("checkbox", {
      name: "Count from completion",
      exact: true,
    }),
  ).toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "Count from completion", exact: true })
    .uncheck();
  await dialog
    .getByRole("combobox", { name: "Repeat", exact: true })
    .selectOption("monthly");
  await dialog
    .getByRole("spinbutton", { name: "Repeat interval", exact: true })
    .fill("1");
  await dialog
    .getByRole("combobox", { name: "Day of month", exact: true })
    .selectOption("30");
  await date.click();
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.locator(".task-save-status")).toHaveText("Saved");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect((await savedTask(request, task.id)).recurrence).toBe(
    "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=30,-1;BYSETPOS=1",
  );
  const step = await createTask(
    request,
    `Synthetic timed step ${crypto.randomUUID()}`,
    {
      kind: "step",
      parent_id: task.id,
      due_date: "2030-01-03",
      duration_minutes: 30,
    },
  );
  const stepDialog = await openTask(page, step.id, "step");
  const stepDate = stepDialog.getByRole("button", {
    name: "Date",
    exact: true,
  });
  await stepDate.click();
  const timeOptions = stepDialog.getByRole("button", {
    name: "Time options",
    exact: true,
  });
  await expect(timeOptions).toHaveAttribute("aria-expanded", "false");
  await expect(timeOptions).toHaveText("Add time");
  await expect(stepDialog.getByLabel("Time", { exact: true })).toHaveCount(0);
  await timeOptions.click();
  await stepDialog.getByLabel("Time", { exact: true }).fill("09:30");
  await timeOptions.click();
  await expect(stepDialog.getByLabel("Time", { exact: true })).toHaveCount(0);
  await expect(timeOptions).toHaveText("Time · 09:30");
  await timeOptions.click();
  await expect(stepDialog.getByLabel("Time", { exact: true })).toHaveValue(
    "09:30",
  );
  const closeGeometry = await stepDate.evaluate(async (button) => {
    if (!(button instanceof HTMLButtonElement))
      throw new Error("Date trigger is not a button");
    const popup = document.querySelector<HTMLElement>(".schedule-popup");
    const extra = popup?.querySelector<HTMLElement>(".schedule-extra");
    if (!popup || !extra) throw new Error("Date picker is not open");
    const before = {
      width: popup.clientWidth,
      height: popup.clientHeight,
      extraHeight: extra.clientHeight,
    };
    button.click();
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => resolve()),
    );
    return {
      before,
      after: {
        width: popup.clientWidth,
        height: popup.clientHeight,
        extraHeight: extra.clientHeight,
      },
    };
  });
  expect(closeGeometry.after).toEqual(closeGeometry.before);
  await stepDate.click();
  await expect(timeOptions).toHaveAttribute("aria-expanded", "false");
  await expect(timeOptions).toHaveText("Time · 09:30");
  await expect(stepDialog.getByLabel("Time", { exact: true })).toHaveCount(0);
  await stepDate.click();
  await stepDialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(stepDialog.locator(".task-save-status")).toHaveText("Saved");
  await stepDialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(stepDialog).not.toBeVisible();
  const timed = await savedTask(request, step.id);
  expect(timed.kind).toBe("step");
  expect(timed.due_date).toBe("2030-01-03");
  expect(timed.due_datetime).toBe("2030-01-03T17:30:00.000Z");
  expect(timed.due_timezone).toBe("America/Los_Angeles");
});

test("a named dependency blocks a task until its real prerequisite is completed", async ({
  page,
  request,
}) => {
  await planningService(page, request);
  const task = await createTask(
    request,
    `Synthetic dependent outcome ${crypto.randomUUID()}`,
  );
  const prerequisite = await createTask(
    request,
    `Synthetic prerequisite ${crypto.randomUUID()}`,
  );
  const dialog = await openTask(page, task.id);
  const dependencies = dialog.getByRole("region", {
    name: "Task dependencies",
    exact: true,
  });
  await expect(dependencies.getByText("Blocked", { exact: true })).toHaveCount(
    0,
  );
  await dependencies
    .getByRole("button", { name: "Add dependency", exact: true })
    .click();
  await dependencies
    .getByRole("textbox", { name: "Search prerequisites", exact: true })
    .fill(prerequisite.title);
  await dependencies
    .getByRole("option", { name: prerequisite.title, exact: true })
    .click();
  await expect(
    dependencies.getByText("Blocked", { exact: true }),
  ).toBeVisible();
  await expect(
    dependencies.getByRole("button", { name: prerequisite.title, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    dependencies.getByText("Blocked", { exact: true }),
  ).toBeVisible();
  const csrf = await request.get("/api/tasks/csrf");
  const { token } = await csrf.json();
  const response = await request.post(
    `/api/tasks/v1/tasks/${prerequisite.id}:complete`,
    {
      headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
      data: { etag: prerequisite.etag, request_id: crypto.randomUUID() },
    },
  );
  expect(response.status(), await response.text()).toBe(200);
  await page.reload();
  await expect(dependencies.getByText("Done", { exact: true })).toBeVisible();
  await expect(dependencies.getByText("Blocked", { exact: true })).toHaveCount(
    0,
  );
  await dependencies
    .getByRole("button", {
      name: `Remove dependency ${prerequisite.title}`,
      exact: true,
    })
    .click();
  await expect(
    dependencies.getByRole("button", { name: prerequisite.title, exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    dependencies.getByRole("button", { name: prerequisite.title, exact: true }),
  ).toHaveCount(0);
  await expect(dependencies.getByText("Blocked", { exact: true })).toHaveCount(
    0,
  );
});

test("clearing a deadline clears its lead and Parked stays exclusive with a chosen stage or progress", async ({
  page,
  request,
}) => {
  const planning = await planningService(page, request);
  const task = await createTask(
    request,
    `Synthetic parked deadline ${crypto.randomUUID()}`,
    { deadline: "2030-03-29" },
  );
  planning.set(task.id, {
    stage: "none",
    area: "work",
    flags: new Set(["parked"]),
    leadDays: 14,
    revision: 1,
  });
  const dialog = await openTask(page, task.id);
  const stage = dialog.getByRole("combobox", {
    name: "Planning stage",
    exact: true,
  });
  const parked = dialog.getByRole("checkbox", { name: "Parked", exact: true });
  const active = dialog.getByRole("checkbox", {
    name: "In progress",
    exact: true,
  });
  await expect(parked).toBeChecked();
  await stage.selectOption("weekly");
  await expect(parked).not.toBeChecked();
  await active.check();
  await parked.check();
  await expect(stage).toHaveValue("none");
  await expect(active).not.toBeChecked();
  await stage.selectOption("committed");
  await expect(parked).not.toBeChecked();
  await dialog.getByRole("button", { name: "Deadline", exact: true }).click();
  await dialog
    .getByRole("button", { name: "No deadline", exact: true })
    .click();
  const amount = dialog.getByRole("spinbutton", {
    name: "Start ahead amount",
    exact: true,
  });
  await expect(amount).toBeDisabled();
  await expect(amount).toHaveValue("");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.locator(".task-save-status")).toHaveText("Saved");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect((await savedTask(request, task.id)).deadline || "").toBe("");
  expect(planning.get(task.id)).toMatchObject({
    stage: "committed",
    leadDays: 0,
  });
  expect(planning.get(task.id)!.flags.has("parked")).toBe(false);
  await page.reload();
  await expect(stage).toHaveValue("committed");
  await expect(amount).toBeDisabled();
  await expect(amount).toHaveValue("");
  await parked.check();
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.locator(".task-save-status")).toHaveText("Saved");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(parked).toBeChecked();
  await expect(stage).toHaveValue("none");
  await expect(active).not.toBeChecked();
});

test("initial child and dependency reads finish before adding, so new children cannot be overwritten", async ({
  page,
  request,
}) => {
  await planningService(page, request);
  const parent = await createTask(
    request,
    `Synthetic initial read ${crypto.randomUUID()}`,
  );
  const existing = await createTask(
    request,
    "Synthetic child present before opening",
    { parent_id: parent.id },
  );
  let releaseChildren!: () => void;
  let releaseDependencies!: () => void;
  let childrenRequested!: () => void;
  let dependenciesRequested!: () => void;
  const heldChildren = new Promise<void>((resolve) => {
    releaseChildren = resolve;
  });
  const heldDependencies = new Promise<void>((resolve) => {
    releaseDependencies = resolve;
  });
  const readingChildren = new Promise<void>((resolve) => {
    childrenRequested = resolve;
  });
  const readingDependencies = new Promise<void>((resolve) => {
    dependenciesRequested = resolve;
  });
  await page.route("**/api/tasks/v1/tasks?*", async (route) => {
    if (
      new URL(route.request().url()).searchParams.get("parent_id") === parent.id
    ) {
      childrenRequested();
      await heldChildren;
    }
    await route.continue();
  });
  await page.route("**/api/plus/v1/plan:read*", async (route) => {
    dependenciesRequested();
    await heldDependencies;
    await route.fallback();
  });
  try {
    const dialog = await openTask(page, parent.id);
    await Promise.all([readingChildren, readingDependencies]);
    const children = dialog.getByRole("region", {
      name: "Subtasks and steps",
      exact: true,
    });
    const dependencies = dialog.getByRole("region", {
      name: "Task dependencies",
      exact: true,
    });
    const title = "Synthetic child added after initial read";
    const name = children.getByRole("textbox", {
      name: "New subtask",
      exact: true,
    });
    await name.fill(title);
    const add = children.getByRole("button", { name: "Add", exact: true });
    const addDependency = dependencies.getByRole("button", {
      name: "Add dependency",
      exact: true,
    });
    await expect(add).toBeDisabled();
    await expect(addDependency).toBeDisabled();
    await name.press("Enter");
    const before = await request.get(
      `/api/tasks/v1/tasks?parent_id=${parent.id}`,
    );
    expect(
      ((await before.json()) as { tasks: SavedTask[] }).tasks.map(
        (task) => task.id,
      ),
    ).toEqual([existing.id]);
    releaseChildren();
    await expect(
      children.getByRole("button", { name: existing.title, exact: true }),
    ).toBeVisible();
    await expect(add).toBeEnabled();
    await expect(addDependency).toBeDisabled();
    await add.click();
    await expect(
      children.getByRole("button", { name: title, exact: true }),
    ).toBeVisible();
    releaseDependencies();
    await expect(addDependency).toBeEnabled();
    await page.reload();
    await expect(
      children.getByRole("button", { name: existing.title, exact: true }),
    ).toBeVisible();
    await expect(
      children.getByRole("button", { name: title, exact: true }),
    ).toBeVisible();
    const after = await request.get(
      `/api/tasks/v1/tasks?parent_id=${parent.id}`,
    );
    expect(
      ((await after.json()) as { tasks: SavedTask[] }).tasks
        .map((task) => task.title)
        .sort(),
    ).toEqual([existing.title, title].sort());
  } finally {
    releaseChildren();
    releaseDependencies();
  }
});
