import {
  test,
  expect,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { beginTaskDrag, dragTask } from "./drag";

async function fixture(request: APIRequestContext) {
  const { token } = await (await request.get("/api/tasks/csrf")).json();
  const create = async (kind: string, values: Record<string, unknown>) => {
    const response = await request.post(
      `/api/tasks/v1/${kind}?request_id=${crypto.randomUUID()}`,
      {
        headers: { origin: "http://127.0.0.1:8798", "x-csrf-token": token },
        data: values,
      },
    );
    expect(response.status()).toBe(200);
    return response.json();
  };
  const project = await create("projects", {
    title: `Synthetic drag ${crypto.randomUUID()}`,
  });
  return {
    project,
    create: (values: Record<string, unknown>) =>
      create("tasks", { project_id: project.id, ...values }),
    read: async (id: string) =>
      (await request.get(`/api/tasks/v1/tasks/${id}`)).json(),
  };
}
function row(page: Page, id: string) {
  return page.locator(`.task-row[data-task-id="${id}"]`);
}

test("whole-row drag reparents a family and promotes it beside its parent with dates and kinds intact", async ({
  page,
  request,
}) => {
  const { project, create, read } = await fixture(request);
  const first = await create({
    title: "Synthetic original outcome",
    sort_order: 1,
  });
  const second = await create({
    title: "Synthetic next outcome",
    sort_order: 2,
  });
  const child = await create({
    title: "Synthetic movable outcome",
    parent_id: first.id,
    due_date: "2040-03-04",
    deadline: "2040-05-06",
    priority: 2,
    effort: "deep",
  });
  const grandchild = await create({
    title: "Synthetic retained subtask",
    parent_id: child.id,
  });
  const step = await create({
    title: "Synthetic retained step",
    parent_id: child.id,
    kind: "step",
    duration_minutes: 45,
  });
  await page.goto(`/#/project/${project.id}`);
  await row(page, first.id)
    .getByRole("button", {
      name: `Expand subtasks for ${first.title}`,
      exact: true,
    })
    .click();
  await expect(row(page, child.id)).toBeVisible();
  await dragTask(
    page,
    row(page, child.id).locator(".task-open"),
    row(page, second.id),
    "inside",
  );
  await expect
    .poll(async () => (await read(child.id)).parent_id)
    .toBe(second.id);
  const newChildren = page.getByRole("list", {
    name: `Subtasks of ${second.title}`,
    exact: true,
  });
  await expect(
    newChildren.locator(`[data-task-id="${child.id}"]`),
  ).toBeVisible();
  await dragTask(
    page,
    row(page, child.id).locator(".task-open"),
    row(page, second.id),
    "after",
  );
  await expect
    .poll(async () => (await read(child.id)).parent_id || "")
    .toBe("");
  await page.reload();
  await expect(row(page, child.id)).toBeVisible();
  expect(await read(child.id)).toMatchObject({
    id: child.id,
    project_id: project.id,
    due_date: "2040-03-04",
    deadline: "2040-05-06",
    priority: 2,
    effort: "deep",
    kind: "task",
  });
  const ordered = await page
    .locator(".task-list > .task-branch > .task-row")
    .evaluateAll((rows) =>
      rows.map((item) => item.getAttribute("data-task-id")),
    );
  expect(ordered).toEqual([first.id, second.id, child.id]);
  expect(await read(grandchild.id)).toMatchObject({
    parent_id: child.id,
    kind: "task",
  });
  expect(await read(step.id)).toMatchObject({
    parent_id: child.id,
    kind: "step",
    duration_minutes: 45,
  });
  await expect(page.getByText(step.title, { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("dialog", { name: "Task details", exact: true }),
  ).toHaveCount(0);
});

test("selection replaces the completion circle without moving the title, and normal controls still open and complete", async ({
  page,
  request,
}) => {
  const { project, create, read } = await fixture(request);
  const parent = await create({ title: "Synthetic selectable parent" });
  const child = await create({
    title: "Synthetic selectable child",
    parent_id: parent.id,
  });
  await page.goto(`/#/project/${project.id}`);
  await row(page, parent.id)
    .getByRole("button", {
      name: `Expand subtasks for ${parent.title}`,
      exact: true,
    })
    .click();
  const taskRow = row(page, child.id);
  await expect(taskRow.getByRole("checkbox")).toHaveCount(0);
  await expect(
    taskRow.getByRole("button", {
      name: `Complete ${child.title}`,
      exact: true,
    }),
  ).toBeVisible();
  const title = taskRow.locator(".task-open");
  const before = await title.boundingBox();
  await taskRow
    .getByRole("button", {
      name: `More actions for ${child.title}`,
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: "Select task", exact: true })
    .click();
  await expect(
    taskRow.getByRole("checkbox", {
      name: `Select ${child.title}`,
      exact: true,
    }),
  ).toBeChecked();
  await expect(taskRow.locator(".complete-button")).toHaveCount(0);
  const selected = await title.boundingBox();
  expect(selected?.x).toBe(before?.x);
  expect(selected?.width).toBe(before?.width);
  await page
    .locator(".selection-bar")
    .getByRole("button", { name: "Clear", exact: true })
    .click();
  await expect(taskRow.getByRole("checkbox")).toHaveCount(0);
  await title.click();
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await expect(
    dialog.getByRole("textbox", { name: "Task name", exact: true }),
  ).toHaveValue(child.title);
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await taskRow
    .getByRole("button", { name: `Complete ${child.title}`, exact: true })
    .click();
  await expect.poll(async () => (await read(child.id)).completed).toBe(true);
  await expect(taskRow).toHaveCount(0);
});

test("drag preview and inside feedback appear, descendants reject a cycle, and Escape cancels without a write", async ({
  page,
  request,
}) => {
  const { project, create, read } = await fixture(request);
  const parent = await create({ title: "Synthetic cycle root" });
  const child = await create({
    title: "Synthetic cycle child",
    parent_id: parent.id,
  });
  const target = await create({ title: "Synthetic drop feedback" });
  await page.goto(`/#/project/${project.id}`);
  await row(page, parent.id)
    .getByRole("button", {
      name: `Expand subtasks for ${parent.title}`,
      exact: true,
    })
    .click();
  const writes: string[] = [];
  page.on("request", (event) => {
    if (event.method() === "PATCH") writes.push(event.url());
  });
  await beginTaskDrag(page, row(page, parent.id).locator(".task-open"));
  await expect(row(page, parent.id)).toHaveClass(/is-dragging/);
  const childBox = await row(page, child.id).boundingBox();
  await page.mouse.move(childBox!.x + 100, childBox!.y + childBox!.height / 2, {
    steps: 6,
  });
  await expect(
    row(page, child.id).locator(".task-drop-zone.is-over"),
  ).toHaveCount(0);
  const targetBox = await row(page, target.id).boundingBox();
  await page.mouse.move(
    targetBox!.x + 100,
    targetBox!.y + targetBox!.height / 2,
    { steps: 6 },
  );
  await expect(row(page, target.id).locator(".task-drop-hint")).toHaveText(
    "Move under this task",
  );
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".task-drag-preview")).toHaveCount(0);
  expect(writes).toEqual([]);
  expect((await read(parent.id)).parent_id || "").toBe("");
  expect((await read(child.id)).parent_id).toBe(parent.id);
  const grip = row(page, parent.id).getByRole("button", {
    name: `Drag ${parent.title}`,
    exact: true,
  });
  await grip.focus();
  await page.keyboard.press("Space");
  await expect(page.locator(".task-drag-preview")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".task-drag-preview")).toHaveCount(0);
  expect(writes).toEqual([]);
});
