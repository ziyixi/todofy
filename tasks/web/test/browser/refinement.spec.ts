import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

test.use({ serviceWorkers: "block", timezoneId: "America/Los_Angeles" });

test.afterEach(async ({ page }) => {
  // Route projections use the request fixture; finish them before that fixture is disposed.
  await page.unrouteAll({ behavior: "wait" });
});

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
  stage?: string;
  area?: string;
  lead_days?: number;
  planning_flags?: string[];
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
  const parent = await createTask(
    request,
    `Synthetic grouped outcome ${crypto.randomUUID()}`,
  );
  const dialog = await openTask(page, parent.id);
  const subtaskTitle = "Synthetic child outcome";
  const stepTitle = "Synthetic small executable step";
  const subtasks = dialog.getByRole("region", {
    name: "Subtasks",
    exact: true,
  });
  const steps = dialog.getByRole("region", { name: "Steps", exact: true });
  const addSubtask = subtasks.getByRole("button", {
    name: "Add subtask",
    exact: true,
  });
  await expect(
    dialog.getByRole("textbox", { name: /^New (step|subtask)$/ }),
  ).toHaveCount(0);
  expect((await steps.boundingBox())!.y).toBeLessThan(
    (await subtasks.boundingBox())!.y,
  );
  await addSubtask.click();
  const subtaskName = subtasks.getByRole("textbox", {
    name: "New subtask",
    exact: true,
  });
  await expect(subtaskName).toBeFocused();
  await addSubtask.click();
  await expect(subtaskName).toBeFocused();
  await subtaskName.fill(subtaskTitle);
  await subtaskName.press("Enter");
  await expect(
    subtasks.getByRole("button", { name: subtaskTitle, exact: true }),
  ).toBeVisible();
  await expect(subtaskName).toBeFocused();
  await subtaskName.press("Escape");
  await expect(subtaskName).toHaveCount(0);
  await expect(addSubtask).toBeFocused();
  await expect(dialog).toBeVisible();
  await steps.getByRole("button", { name: "Add step", exact: true }).click();
  await expect(
    steps.getByRole("textbox", { name: "New step", exact: true }),
  ).toBeFocused();
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
  await expect(
    steps.getByRole("textbox", { name: "New step", exact: true }),
  ).toBeFocused();
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
  await expect(subtasks.locator("h3 > span")).toHaveText("0/0");
  await expect(steps.locator("h3 > span")).toHaveText("0/0");
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
    .getByRole("radiogroup", { name: "Execution", exact: true })
    .getByText("Standalone", { exact: true })
    .click();
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
  await expect(dialog).not.toBeVisible();
  // Content and planning are one write of the task in D1.
  const saved = await savedTask(request, task.id);
  expect(saved).toMatchObject({
    effort: "deep",
    deadline: "2030-02-28",
    stage: "committed",
    area: "work",
    lead_days: 14,
    planning_flags: ["task"],
    etag: "2",
  });
  // Closing the editor removes its task link, so reopen the task from a fresh page.
  await openTask(page, task.id);
  await expect(
    dialog.getByRole("combobox", { name: "Planning stage", exact: true }),
  ).toHaveValue("committed");
  await expect(
    dialog.getByRole("combobox", { name: "Task context", exact: true }),
  ).toHaveValue("work");
  await expect(
    dialog.getByRole("radio", { name: "Standalone", exact: true }),
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

test("Execution changes Quick to Standalone to Steps, preserving Routine and existing status flags", async ({
  page,
  request,
}) => {
  const task = await createTask(
    request,
    `Synthetic execution modes ${crypto.randomUUID()}`,
    {
      due_date: "2030-01-02",
      duration_minutes: 45,
      planning_flags: ["active", "waiting", "onhold", "routine"],
    },
  );
  const dialog = await openTask(page, task.id);
  const execution = dialog.getByRole("radiogroup", {
    name: "Execution",
    exact: true,
  });
  const routine = dialog.getByRole("switch", { name: "Routine", exact: true });
  const date = dialog.getByRole("button", { name: "Date", exact: true });
  const estimate = dialog.getByRole("spinbutton", {
    name: "Duration (minutes)",
    exact: true,
  });
  const timeOptions = dialog.getByRole("button", {
    name: "Time options",
    exact: true,
  });
  const save = dialog.getByRole("button", {
    name: "Save changes",
    exact: true,
  });
  const checkedMode = async (name: string) => {
    await expect(execution.getByRole("radio")).toHaveCount(3);
    await expect(execution.getByRole("radio", { checked: true })).toHaveCount(
      1,
    );
    await expect(
      execution.getByRole("radio", { name, exact: true }),
    ).toBeChecked();
    await expect(routine).toBeChecked();
  };
  await checkedMode("Steps");
  await expect(estimate).toHaveCount(0);
  await date.click();
  await expect(timeOptions).toHaveCount(0);
  await dialog.locator(".schedule-popup").press("Escape");

  await execution.getByText("Quick", { exact: true }).click();
  await checkedMode("Quick");
  // Scheduling controls follow the draft immediately, before any save.
  await expect(estimate).toHaveCount(0);
  await date.click();
  await expect(timeOptions).toBeVisible();
  await timeOptions.click();
  await dialog.getByLabel("Time", { exact: true }).fill("14:15");
  await dialog.locator(".schedule-popup").press("Escape");
  await save.click();
  await expect(dialog).not.toBeVisible();
  const quick = await savedTask(request, task.id);
  expect(quick.planning_flags).toEqual([
    "quick",
    "waiting",
    "active",
    "onhold",
    "routine",
    "task",
  ]);
  expect(quick.duration_minutes).toBe(45);
  expect(quick.due_datetime).toBeTruthy();
  await openTask(page, task.id);
  await checkedMode("Quick");
  await expect(estimate).toHaveCount(0);

  await execution.getByText("Standalone", { exact: true }).click();
  await checkedMode("Standalone");
  await expect(estimate).toBeVisible();
  await expect(estimate).toHaveValue("45");
  await date.click();
  await expect(timeOptions).toBeVisible();
  await dialog.locator(".schedule-popup").press("Escape");
  await save.click();
  await expect(dialog).not.toBeVisible();
  expect((await savedTask(request, task.id)).planning_flags).toEqual([
    "waiting",
    "active",
    "onhold",
    "routine",
    "task",
  ]);

  await openTask(page, task.id);
  await execution.getByText("Steps", { exact: true }).click();
  await checkedMode("Steps");
  await expect(estimate).toHaveCount(0);
  await date.click();
  await expect(timeOptions).toHaveCount(0);
  await expect(dialog.getByLabel("Time", { exact: true })).toHaveCount(0);
  await dialog.locator(".schedule-popup").press("Escape");
  await save.click();
  await expect(dialog).not.toBeVisible();
  const steps = await savedTask(request, task.id);
  expect(steps.planning_flags).toEqual([
    "waiting",
    "active",
    "onhold",
    "routine",
  ]);
  expect(steps.duration_minutes).toBe(45);
  expect(steps.due_datetime).toBe(quick.due_datetime);
  await openTask(page, task.id);
  await checkedMode("Steps");
  await expect(estimate).toHaveCount(0);
});

test("repeat controls save calendar rules while only steps expose a clock time", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1080, height: 900 });
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
  await expect(dialog).not.toBeVisible();
  expect((await savedTask(request, task.id)).recurrence).toBe(
    "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR",
  );
  // Closing the editor removes its task link, so reopen the task from a fresh page.
  await openTask(page, task.id);
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
  await expect(dialog).not.toBeVisible();
  expect((await savedTask(request, task.id)).recurrence).toBe("every! 2 weeks");
  await openTask(page, task.id);
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
  await expect(dialog).not.toBeVisible();
  expect((await savedTask(request, task.id)).recurrence).toBe(
    "RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=30,-1;BYSETPOS=1",
  );
  // The row reads the rule in words and keeps the stored rule in its title.
  await expect(
    page
      .locator(".task-row", { hasText: task.title })
      .getByTitle("RRULE:FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=30,-1;BYSETPOS=1"),
  ).toHaveText("Monthly on the 30th (or last day)");
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

test("legacy manual flags survive unrelated edits, while choosing a stage unparks and clearing a deadline clears its lead", async ({
  page,
  request,
}) => {
  const task = await createTask(
    request,
    `Synthetic retained parked deadline ${crypto.randomUUID()}`,
    {
      due_date: "2030-03-15",
      deadline: "2030-03-29",
      area: "work",
      effort: "deep",
      planning_flags: ["parked", "waiting", "onhold", "routine"],
      lead_days: 14,
    },
  );
  const dialog = await openTask(page, task.id);
  const stage = dialog.getByRole("combobox", {
    name: "Planning stage",
    exact: true,
  });
  for (const name of ["In progress", "Waiting", "On hold", "Parked"])
    await expect(
      dialog.getByRole("checkbox", { name, exact: true }),
    ).toHaveCount(0);
  await expect(stage).toHaveValue("none");
  await expect(
    dialog.getByRole("switch", { name: "Routine", exact: true }),
  ).toBeChecked();
  await dialog
    .getByRole("combobox", { name: "Task context", exact: true })
    .selectOption("personal");
  await dialog
    .getByRole("radiogroup", { name: "Execution", exact: true })
    .getByText("Standalone", { exact: true })
    .click();
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  expect((await savedTask(request, task.id)).planning_flags).toEqual([
    "waiting",
    "parked",
    "onhold",
    "routine",
    "task",
  ]);

  await openTask(page, task.id);
  await stage.selectOption("committed");
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
  await expect(dialog).not.toBeVisible();
  const cleared = await savedTask(request, task.id);
  expect(cleared.deadline || "").toBe("");
  expect(cleared.stage).toBe("committed");
  expect(cleared.lead_days ?? 0).toBe(0);
  expect(cleared.planning_flags).toEqual([
    "waiting",
    "onhold",
    "routine",
    "task",
  ]);
  expect(cleared).toMatchObject({
    due_date: "2030-03-15",
    area: "personal",
    effort: "deep",
  });
  await expect(dialog).not.toBeVisible();
  await openTask(page, task.id);
  await expect(stage).toHaveValue("committed");
  await expect(amount).toBeDisabled();
  await expect(amount).toHaveValue("");
  await expect(
    dialog.getByRole("radio", { name: "Standalone", exact: true }),
  ).toBeChecked();
  await expect(
    dialog.getByRole("switch", { name: "Routine", exact: true }),
  ).toBeChecked();
});

test("the initial children read finishes before adding, so new children cannot be overwritten", async ({
  page,
  request,
}) => {
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
  let childrenRequested!: () => void;
  const heldChildren = new Promise<void>((resolve) => {
    releaseChildren = resolve;
  });
  const readingChildren = new Promise<void>((resolve) => {
    childrenRequested = resolve;
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
  try {
    const dialog = await openTask(page, parent.id);
    await readingChildren;
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
    const addSubtask = children.getByRole("button", {
      name: "Add subtask",
      exact: true,
    });
    const addDependency = dependencies.getByRole("button", {
      name: "Add dependency",
      exact: true,
    });
    await expect(addSubtask).toBeDisabled();
    await expect(name).toHaveCount(0);
    // The task's dependencies came with GetTask: nothing to wait for.
    await expect(addDependency).toBeEnabled();
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
    await expect(addSubtask).toBeEnabled();
    await addSubtask.click();
    await expect(name).toBeFocused();
    await name.fill(title);
    await children.getByRole("button", { name: "Add", exact: true }).click();
    await expect(
      children.getByRole("button", { name: title, exact: true }),
    ).toBeVisible();
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
  }
});
