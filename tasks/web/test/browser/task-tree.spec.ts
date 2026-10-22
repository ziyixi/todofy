import { dragTask, beginTaskDrag, dropTaskOn } from "./drag";
import { expect, test, type APIRequestContext } from "@playwright/test";

async function creator(request: APIRequestContext, resource = "tasks") {
  const { token } = await (await request.get("/api/tasks/csrf")).json();
  return async (task: Record<string, unknown>) => {
    const response = await request.post(
      `/api/tasks/v1/${resource}?request_id=${crypto.randomUUID()}`,
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
  const sibling = await create({
    title: "Synthetic tree sibling",
    parent_id: parent.id,
  });
  const step = await create({
    title: "Synthetic hidden step",
    parent_id: parent.id,
    kind: "step",
    duration_minutes: 30,
  });
  await create({ title: "Synthetic tree grandchild", parent_id: child.id });
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
  await expect(list.getByText(sibling.title, { exact: true })).toBeVisible();
  await expect(list.getByText(step.title, { exact: true })).toHaveCount(0);
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
  await expect(dialog.locator(".task-save-status")).toHaveText("Saved");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(
    list.getByText("Synthetic tree edited child", { exact: true }),
  ).toBeVisible();
  const editedRow = list.locator(".task-row").filter({
    has: page.getByText("Synthetic tree edited child", { exact: true }),
  });
  const siblingRow = list
    .locator(".task-row")
    .filter({ has: page.getByText(sibling.title, { exact: true }) });
  const ordered = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().includes(`/tasks/${sibling.id}`),
  );
  await dragTask(page, siblingRow.locator(".task-open"), editedRow);
  expect((await ordered).status()).toBe(200);
  await expect
    .poll(() => list.locator(".task-title").allTextContents())
    .toEqual([sibling.title, "Synthetic tree edited child"]);
  await list
    .getByRole("button", { name: `Complete ${sibling.title}`, exact: true })
    .click();
  await expect(list.getByText(sibling.title, { exact: true })).toHaveCount(0);
  expect(
    (await (await request.get(`/api/tasks/v1/tasks/${sibling.id}`)).json())
      .completed,
  ).toBe(true);
  await page.getByRole("checkbox", { name: "Completed", exact: true }).check();
  await expect(list.getByText(sibling.title, { exact: true })).toBeVisible();
  await expect(
    list.getByRole("button", { name: `Reopen ${sibling.title}`, exact: true }),
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
  await page.goto("/#/inbox");
  await page.getByText(parent.title, { exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Add subtask", exact: true }).click();
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
    .getByText("Synthetic paged child 102", { exact: true })
    .click({ modifiers: ["ControlOrMeta"] });
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
  await dragTask(
    page,
    subtasks.getByRole("button", { name: subtaskB.title, exact: true }),
    subtasks.locator(".task-child-row").filter({
      has: page.getByRole("button", { name: subtaskA.title, exact: true }),
    }),
  );
  expect((await beforeSubtask).status()).toBe(200);
  await expect(subtasks.locator(".task-child-title")).toHaveText([
    subtaskB.title,
    subtaskA.title,
  ]);
  const stepTarget = steps.locator(".task-child-row").filter({
    has: page.getByRole("button", { name: stepB.title, exact: true }),
  });
  const afterStep = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      r.url().includes(`/tasks/${stepA.id}`),
  );
  await dragTask(
    page,
    steps.getByRole("button", { name: stepA.title, exact: true }),
    stepTarget,
    "after",
  );
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

test("saving existing tasks, subtasks and steps preserves the editor, scroll and fresh write baseline", async ({
  page,
  request,
}) => {
  const create = await creator(request);
  const parent = await create({
    title: `Synthetic persistent editor ${crypto.randomUUID()}`,
  });
  const child = await create({
    title: "Synthetic editable subtask",
    parent_id: parent.id,
  });
  const step = await create({
    title: "Synthetic editable step",
    parent_id: parent.id,
    kind: "step",
    duration_minutes: 30,
  });
  await page.setViewportSize({ width: 1280, height: 620 });
  let patches = 0;
  page.on("request", (r) => {
    if (
      r.method() === "PATCH" &&
      new URL(r.url()).pathname.startsWith("/api/tasks/")
    )
      patches++;
  });
  for (const [task, role] of [
    [parent, "Task details"],
    [child, "Task details"],
    [step, "Step details"],
  ] as const) {
    await page.goto(`/?task=${task.id}#/inbox`);
    const dialog = page.getByRole("dialog", { name: role, exact: true });
    const title = dialog.getByRole("textbox", {
      name: "Task name",
      exact: true,
    });
    await title.fill(`${task.title} edited`);
    const body = dialog.locator(".task-edit-body");
    const scroll = await body.evaluate((el) => {
      el.scrollTop = 90;
      return el.scrollTop;
    });
    const frame = await dialog.boundingBox();
    const save = dialog.getByRole("button", {
      name: "Save changes",
      exact: true,
    });
    const saveFrame = await save.boundingBox();
    await save.click();
    await expect(dialog.locator(".task-save-status")).toHaveText("Saved");
    expect(await dialog.boundingBox()).toEqual(frame);
    expect(await save.boundingBox()).toEqual(saveFrame);
    expect(await body.evaluate((el) => el.scrollTop)).toBe(scroll);
    await title.fill(`${task.title} edited twice`);
    await expect(dialog.locator(".task-save-status")).toHaveText("");
    await save.click();
    await expect(dialog.locator(".task-save-status")).toHaveText("Saved");
    const before = await (
      await request.get(`/api/tasks/v1/tasks/${task.id}`)
    ).json();
    expect(before.title).toBe(`${task.title} edited twice`);
    const writes = patches;
    await save.click();
    await expect(dialog.locator(".task-save-status")).toHaveText("Saved");
    expect(patches).toBe(writes);
    const after = await (
      await request.get(`/api/tasks/v1/tasks/${task.id}`)
    ).json();
    expect(after.etag).toBe(before.etag);
    await dialog
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
  }
});

test("main-list dragging can detach a subtask without changing its dates, project or descendants", async ({
  page,
  request,
}) => {
  const project = await (
    await creator(request, "projects")
  )({ title: `Synthetic detach project ${crypto.randomUUID()}` });
  const create = await creator(request);
  const parent = await create({
    title: `Synthetic detach parent ${crypto.randomUUID()}`,
    project_id: project.id,
  });
  const child = await create({
    title: "Synthetic detach child",
    parent_id: parent.id,
    due_date: "2040-03-04",
    deadline: "2040-04-05",
    priority: 2,
  });
  const other = await create({
    title: "Synthetic detach by drop zone",
    parent_id: parent.id,
  });
  const grandchild = await create({
    title: "Synthetic retained grandchild",
    parent_id: child.id,
  });
  const step = await create({
    title: "Synthetic retained hidden step",
    parent_id: child.id,
    kind: "step",
    duration_minutes: 45,
  });
  const before = await (
    await request.get(`/api/tasks/v1/tasks/${child.id}`)
  ).json();
  await page.goto(`/#/project/${project.id}`);
  await page
    .getByRole("button", {
      name: `Expand subtasks for ${parent.title}`,
      exact: true,
    })
    .click();
  const nested = page.getByRole("list", {
    name: `Subtasks of ${parent.title}`,
    exact: true,
  });
  const rootRow = page.locator(".task-row").filter({
    has: page.getByRole("button", {
      name: `Drag ${parent.title}`,
      exact: true,
    }),
  });
  const detached = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      r.url().includes(`/tasks/${child.id}`),
  );
  // The visual wrapper remains mounted while idle and after its preview disappears.
  await expect(page.locator("[data-dnd-overlay]")).toHaveCSS(
    "pointer-events",
    "none",
  );
  await dragTask(page, nested.getByText(child.title, { exact: true }), rootRow);
  expect((await detached).status()).toBe(200);
  await expect(nested.getByText(child.title, { exact: true })).toHaveCount(0);
  const secondDetach = page.waitForResponse(
    (r) =>
      r.request().method() === "PATCH" &&
      r.url().includes(`/tasks/${other.id}`),
  );
  await beginTaskDrag(page, nested.getByText(other.title, { exact: true }));
  await dropTaskOn(
    page,
    page.getByRole("region", { name: "Make independent task", exact: true }),
  );
  expect((await secondDetach).status()).toBe(200);
  await page.reload();
  await expect(
    page.locator(".task-list > .task-branch > .task-row .task-title"),
  ).toHaveText([child.title, parent.title, other.title]);
  const after = await (
    await request.get(`/api/tasks/v1/tasks/${child.id}`)
  ).json();
  expect(after.parent_id || "").toBe("");
  for (const key of [
    "id",
    "kind",
    "project_id",
    "section_id",
    "due_date",
    "deadline",
    "priority",
  ])
    expect(after[key]).toEqual(before[key]);
  for (const descendant of [grandchild, step])
    expect(
      (await (await request.get(`/api/tasks/v1/tasks/${descendant.id}`)).json())
        .parent_id,
    ).toBe(child.id);
  await page
    .getByRole("button", {
      name: `Expand subtasks for ${child.title}`,
      exact: true,
    })
    .click();
  await expect(page.getByText(grandchild.title, { exact: true })).toBeVisible();
  await expect(page.getByText(step.title, { exact: true })).toHaveCount(0);
});
