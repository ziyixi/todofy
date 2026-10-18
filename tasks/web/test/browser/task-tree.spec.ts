import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

async function creator(request: APIRequestContext) {
  const { token } = await (await request.get("/api/tasks/csrf")).json();
  return async (task: Record<string, unknown>) => {
    const response = await request.post(
      `/api/tasks/v1/tasks?request_id=${crypto.randomUUID()}`,
      {
        headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
        data: task,
      },
    );
    expect(response.status()).toBe(200);
    return response.json() as Promise<{
      id: string;
      title: string;
      name: string;
    }>;
  };
}
async function planning(page: Page) {
  await page.route("**/api/plus/v1/plan:read", (route) =>
    route.fulfill({
      json: { plan: { native_planning: true, dependencies: [] } },
    }),
  );
  await page.route("**/api/plus/v1/tasks?**", (route) =>
    route.fulfill({
      json: {
        planning_tasks: [
          {
            id: new URL(route.request().url()).searchParams.get("task_ids"),
            etag: "synthetic-tree",
            explicit_stage: "none",
            area: "unassigned",
            planning_flags: [],
            lead_days: 0,
            deadline: "",
          },
        ],
      },
    }),
  );
}

test("subtasks start folded and load only on expansion, with nested steps, editing and completion", async ({
  page,
  request,
}) => {
  const create = await creator(request);
  const parent = await create({
    title: `Synthetic tree parent ${crypto.randomUUID()}`,
  });
  const child = await create({
    title: "Synthetic tree child",
    parent_id: parent.id,
  });
  const step = await create({
    title: "Synthetic tree step",
    parent_id: parent.id,
    kind: "step",
    duration_minutes: 30,
  });
  await create({ title: "Synthetic tree grandchild", parent_id: child.id });
  await planning(page);
  const parentReads: string[] = [];
  page.on("request", (event) => {
    const id = new URL(event.url()).searchParams.get("parent_id");
    if (id) parentReads.push(id);
  });
  await page.goto("/#/inbox");
  const expand = page.getByRole("button", {
    name: `Expand subtasks for ${parent.title}`,
    exact: true,
  });
  await expect(expand).toBeVisible();
  await expect(page.getByText(child.title, { exact: true })).toHaveCount(0);
  expect(parentReads).toEqual([]);
  await expand.click();
  const list = page.getByRole("list", {
    name: `Subtasks of ${parent.title}`,
    exact: true,
  });
  await expect(list.getByText(child.title, { exact: true })).toBeVisible();
  await expect(list.getByText(step.title, { exact: true })).toBeVisible();
  await expect(
    list.getByText("Synthetic tree grandchild", { exact: true }),
  ).toHaveCount(0);
  await list
    .getByRole("button", {
      name: `Expand subtasks for ${child.title}`,
      exact: true,
    })
    .click();
  await expect(
    list.getByText("Synthetic tree grandchild", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: `Collapse subtasks for ${parent.title}`,
      exact: true,
    })
    .click();
  await expect(list).not.toBeVisible();
  await expand.click();
  await expect(list.getByText(child.title, { exact: true })).toBeVisible();
  await expect(
    list.getByText("Synthetic tree grandchild", { exact: true }),
  ).toHaveCount(0);
  await list.getByText(child.title, { exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await expect(
    dialog.getByRole("combobox", { name: "Planning stage", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("textbox", { name: "Task name", exact: true })
    .fill("Synthetic tree edited child");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    list.getByText("Synthetic tree edited child", { exact: true }),
  ).toBeVisible();
  const editedRow = list.locator(".task-row").filter({
    has: page.getByText("Synthetic tree edited child", { exact: true }),
  });
  const stepRow = list
    .locator(".task-row")
    .filter({ has: page.getByText(step.title, { exact: true }) });
  const ordered = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().includes(`/tasks/${step.id}`),
  );
  await stepRow
    .getByRole("button", { name: `Drag ${step.title}`, exact: true })
    .dragTo(editedRow);
  expect((await ordered).status()).toBe(200);
  await expect
    .poll(() => list.locator(".task-title").allTextContents())
    .toEqual([step.title, "Synthetic tree edited child"]);
  await list
    .getByRole("button", { name: `Complete ${step.title}`, exact: true })
    .click();
  await expect(list.getByText(step.title, { exact: true })).toHaveCount(0);
  expect(
    (await (await request.get(`/api/tasks/v1/tasks/${step.id}`)).json())
      .completed,
  ).toBe(true);
  await page.getByRole("checkbox", { name: "Completed", exact: true }).check();
  await expect(list.getByText(step.title, { exact: true })).toBeVisible();
  await expect(
    list.getByRole("button", { name: `Reopen ${step.title}`, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(expand).toBeVisible();
  await expect(
    page.getByText("Synthetic tree edited child", { exact: true }),
  ).toHaveCount(0);
});

test("adding the first child in details makes its parent expandable in the main list", async ({
  page,
  request,
}) => {
  const create = await creator(request);
  const parent = await create({
    title: `Synthetic first child parent ${crypto.randomUUID()}`,
  });
  await planning(page);
  await page.goto("/#/inbox");
  await page.getByText(parent.title, { exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await dialog
    .getByRole("textbox", { name: "New subtask", exact: true })
    .fill("Synthetic first added child");
  await expect(
    dialog
      .getByRole("region", { name: "Subtasks and steps", exact: true })
      .getByRole("status"),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    dialog.getByText("Synthetic first added child", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: `Expand subtasks for ${parent.title}`,
      exact: true,
    })
    .click();
  await expect(
    page
      .getByRole("list", { name: `Subtasks of ${parent.title}`, exact: true })
      .getByText("Synthetic first added child", { exact: true }),
  ).toBeVisible();
});

test("a matching Today subtask is not duplicated when its parent expands", async ({
  page,
  request,
}) => {
  const create = await creator(request);
  const parent = await create({
    title: `Synthetic dated tree ${crypto.randomUUID()}`,
    due_date: "2000-01-01",
  });
  const visible = await create({
    title: "Synthetic matching dated child",
    parent_id: parent.id,
    due_date: "2000-01-01",
  });
  const hidden = await create({
    title: "Synthetic undated child",
    parent_id: parent.id,
  });
  await page.goto("/#/today");
  await expect(page.getByText(visible.title, { exact: true })).toHaveCount(1);
  await page
    .getByRole("button", {
      name: `Expand subtasks for ${parent.title}`,
      exact: true,
    })
    .click();
  const list = page.getByRole("list", {
    name: `Subtasks of ${parent.title}`,
    exact: true,
  });
  await expect(list.getByText(hidden.title, { exact: true })).toBeVisible();
  await expect(list.getByText(visible.title, { exact: true })).toHaveCount(0);
  await expect(page.getByText(visible.title, { exact: true })).toHaveCount(1);
});

test("expanded children use bounded pages and participate in selected-task actions", async ({
  page,
  request,
}) => {
  const create = await creator(request);
  const parent = await create({
    title: `Synthetic paged tree ${crypto.randomUUID()}`,
  });
  for (let start = 0; start < 103; start += 8)
    await Promise.all(
      Array.from({ length: Math.min(8, 103 - start) }, (_, offset) =>
        create({
          title: `Synthetic paged child ${start + offset}`,
          parent_id: parent.id,
          sort_order: start + offset,
        }),
      ),
    );
  await page.goto("/#/inbox");
  await page
    .getByRole("button", {
      name: `Expand subtasks for ${parent.title}`,
      exact: true,
    })
    .click();
  const list = page.getByRole("list", {
    name: `Subtasks of ${parent.title}`,
    exact: true,
  });
  await expect(list.locator(".task-row")).toHaveCount(100);
  await list
    .getByRole("button", { name: "Load more subtasks", exact: true })
    .click();
  await expect(list.locator(".task-row")).toHaveCount(103);
  await list
    .getByRole("checkbox", {
      name: "Select Synthetic paged child 102",
      exact: true,
    })
    .check();
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "Complete", exact: true })
    .click();
  await expect(page.locator(".selection-bar")).not.toBeVisible();
  await expect(
    list.getByText("Synthetic paged child 102", { exact: true }),
  ).toHaveCount(0);
});

test("task details reorder both subtasks and steps by dragging and keep the saved order after reopening", async ({
  page,
  request,
}) => {
  const create = await creator(request);
  const parent = await create({
    title: `Synthetic editor order ${crypto.randomUUID()}`,
  });
  const subtaskA = await create({
    title: "Synthetic first outcome",
    parent_id: parent.id,
    sort_order: 1,
  });
  const subtaskB = await create({
    title: "Synthetic second outcome",
    parent_id: parent.id,
    sort_order: 2,
  });
  const stepA = await create({
    title: "Synthetic first step",
    kind: "step",
    parent_id: parent.id,
    duration_minutes: 30,
    sort_order: 3,
  });
  const stepB = await create({
    title: "Synthetic second step",
    kind: "step",
    parent_id: parent.id,
    duration_minutes: 45,
    sort_order: 4,
  });
  await planning(page);
  await page.goto("/#/inbox");
  await page
    .getByRole("combobox", { name: "Sort tasks", exact: true })
    .selectOption({ label: "Name" });
  await page.getByText(parent.title, { exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  const subtasks = dialog.getByRole("region", {
    name: "Subtasks",
    exact: true,
  });
  const steps = dialog.getByRole("region", { name: "Steps", exact: true });
  await expect(
    subtasks.getByRole("button", {
      name: `Drag ${subtaskB.title}`,
      exact: true,
    }),
  ).toBeVisible();
  const beforeSubtask = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      r.url().includes(`/tasks/${subtaskB.id}`),
  );
  await subtasks
    .getByRole("button", { name: `Drag ${subtaskB.title}`, exact: true })
    .dragTo(
      subtasks.locator(".task-child-row").filter({
        has: page.getByRole("button", {
          name: subtaskA.title,
          exact: true,
        }),
      }),
      { targetPosition: { x: 80, y: 3 } },
    );
  expect((await beforeSubtask).status()).toBe(200);
  await expect(subtasks.locator(".task-child-title")).toHaveText([
    subtaskB.title,
    subtaskA.title,
  ]);
  const stepTarget = steps.locator(".task-child-row").filter({
    has: page.getByRole("button", { name: stepB.title, exact: true }),
  });
  const stepBox = await stepTarget.boundingBox();
  const afterStep = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      r.url().includes(`/tasks/${stepA.id}`),
  );
  await steps
    .getByRole("button", { name: `Drag ${stepA.title}`, exact: true })
    .dragTo(stepTarget, { targetPosition: { x: 80, y: stepBox!.height - 3 } });
  expect((await afterStep).status()).toBe(200);
  await expect(steps.locator(".task-child-title")).toHaveText([
    stepB.title,
    stepA.title,
  ]);
  await page.reload();
  await page.getByText(parent.title, { exact: true }).click();
  await expect(subtasks.locator(".task-child-title")).toHaveText([
    subtaskB.title,
    subtaskA.title,
  ]);
  await expect(steps.locator(".task-child-title")).toHaveText([
    stepB.title,
    stepA.title,
  ]);
  for (const [child, kind, duration] of [
    [subtaskA, "task", 0],
    [subtaskB, "task", 0],
    [stepA, "step", 30],
    [stepB, "step", 45],
  ] as const) {
    const saved = await (
      await request.get(`/api/tasks/v1/tasks/${child.id}`)
    ).json();
    expect(saved.parent_id).toBe(parent.id);
    expect(saved.kind).toBe(kind);
    expect(saved.duration_minutes || 0).toBe(duration);
    expect(saved.completed || false).toBe(false);
  }
});
