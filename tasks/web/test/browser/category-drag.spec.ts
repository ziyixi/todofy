import { dragTask } from "./drag";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

async function writer(request: APIRequestContext) {
  const { token } = await (await request.get("/api/tasks/csrf")).json();
  return async (resource: string, value: Record<string, unknown>) => {
    const response = await request.post(
      `/api/tasks/v1/${resource}?request_id=${crypto.randomUUID()}`,
      {
        headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
        data: value,
      },
    );
    expect(response.status()).toBe(200);
    return response.json() as Promise<{
      id: string;
      name: string;
      title: string;
    }>;
  };
}

async function planning(page: Page) {
  await page.route("**/api/plus/v1/tasks?**", (route) => {
    const ids = new URL(route.request().url()).searchParams.getAll("task_ids");
    return route.fulfill({
      json: {
        planning_tasks: ids.map((id) => ({
          id,
          etag: "synthetic-category",
          explicit_stage: "none",
          area: "unassigned",
        })),
      },
    });
  });
}

test("sidebar drops move a subtask family, add a label and schedule Today without changing its deadline", async ({
  page,
  request,
}) => {
  const write = await writer(request);
  const suffix = crypto.randomUUID();
  const source = await write("projects", {
    title: `Synthetic source ${suffix}`,
  });
  const destination = await write("projects", {
    title: `Synthetic destination ${suffix}`,
  });
  const firstLabel = await write("labels", {
    title: `Synthetic original ${suffix}`,
  });
  const addedLabel = await write("labels", {
    title: `Synthetic added ${suffix}`,
    favorite: true,
  });
  const parent = await write("tasks", {
    title: `Synthetic parent ${suffix}`,
    project_id: source.id,
  });
  const child = await write("tasks", {
    title: `Synthetic movable ${suffix}`,
    parent_id: parent.id,
    project_id: source.id,
    label_ids: [firstLabel.id],
    deadline: "2040-04-22",
    due_date: "2030-11-15",
    priority: 2,
  });
  const grandchild = await write("tasks", {
    title: "Synthetic descendant",
    parent_id: child.id,
  });
  const step = await write("tasks", {
    title: "Synthetic hidden step",
    parent_id: child.id,
    kind: "step",
  });
  await planning(page);
  await page.goto(`/#/project/${source.id}`);
  await page
    .getByRole("button", {
      name: `Expand subtasks for ${parent.title}`,
      exact: true,
    })
    .click();
  await dragTask(
    page,
    page.getByText(child.title, { exact: true }),
    page.getByRole("link", { name: destination.title, exact: true }),
  );
  const readChild = async () =>
    (await request.get(`/api/tasks/v1/tasks/${child.id}`)).json();
  await expect
    .poll(async () => (await readChild()).project_id)
    .toBe(destination.id);
  expect(await readChild()).toMatchObject({
    deadline: "2040-04-22",
    due_date: "2030-11-15",
    priority: 2,
  });
  expect((await readChild()).parent_id || "").toBe("");
  for (const id of [grandchild.id, step.id]) {
    const descendant = await (
      await request.get(`/api/tasks/v1/tasks/${id}`)
    ).json();
    expect(descendant).toMatchObject({
      project_id: destination.id,
      parent_id: child.id,
    });
  }
  await expect(page).toHaveURL(new RegExp(source.id));
  await page
    .getByRole("link", { name: destination.title, exact: true })
    .click();
  const drag = () => page.getByText(child.title, { exact: true });
  await dragTask(
    page,
    drag(),
    page.getByRole("link", { name: addedLabel.title, exact: true }),
  );
  await expect
    .poll(async () => (await readChild()).label_ids)
    .toEqual([firstLabel.id, addedLabel.id]);
  await dragTask(
    page,
    drag(),
    page.getByRole("link", { name: "Today", exact: true }),
  );
  const catalog = await (await request.get("/api/tasks/v1/catalog")).json();
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: catalog.time_zone || "UTC",
  }).format(new Date());
  await expect.poll(async () => (await readChild()).due_date).toBe(today);
  expect((await readChild()).deadline).toBe("2040-04-22");
  await dragTask(
    page,
    drag(),
    page.getByRole("link", { name: "Inbox", exact: true }),
  );
  await expect.poll(async () => (await readChild()).project_id || "").toBe("");
  expect(await readChild()).toMatchObject({
    id: child.id,
    deadline: "2040-04-22",
  });
  const descendant = await (
    await request.get(`/api/tasks/v1/tasks/${grandchild.id}`)
  ).json();
  expect(descendant.project_id || "").toBe("");
  expect(descendant.parent_id).toBe(child.id);
});

test("native property metadata loads in a batch without shifting rows or masquerading as labels", async ({
  page,
  request,
}) => {
  const write = await writer(request);
  const project = await write("projects", {
    title: `Synthetic metadata ${crypto.randomUUID()}`,
  });
  const label = await write("labels", { title: "Synthetic ordinary label" });
  const parent = await write("tasks", {
    title: "Synthetic native properties",
    project_id: project.id,
    effort: "deep",
    deadline: "2040-04-22",
    label_ids: [label.id],
  });
  const sibling = await write("tasks", {
    title: "Synthetic metadata sibling",
    project_id: project.id,
  });
  const child = await write("tasks", {
    title: "Synthetic child properties",
    parent_id: parent.id,
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const batches: string[][] = [];
  await page.route("**/api/plus/v1/tasks?**", async (route) => {
    const ids = new URL(route.request().url()).searchParams.getAll("task_ids");
    batches.push(ids);
    if (batches.length === 1) await held;
    await route.fulfill({
      json: {
        planning_tasks: ids.map((id) => ({
          id,
          etag: "synthetic-metadata",
          explicit_stage: "committed",
          area: "work",
          planning_flags: ["routine", "task"],
        })),
      },
    });
  });
  await page.goto(`/#/project/${project.id}`);
  const row = page
    .locator(".task-row")
    .filter({ has: page.getByText(parent.title, { exact: true }) });
  await expect(row).toBeVisible();
  await expect.poll(() => batches.length).toBe(1);
  expect(batches[0]).toEqual([parent.id, sibling.id]);
  const before = await row.boundingBox();
  const labelBefore = await row.locator(".task-real-labels").boundingBox();
  await expect(row.locator(".task-native-properties")).toContainText("#Deep");
  await expect(row.locator(".task-native-properties")).not.toContainText(
    "#Routine",
  );
  release();
  await expect(row.locator(".task-native-properties")).toContainText(
    "#Routine",
  );
  await expect(row.locator(".task-native-properties")).toContainText(
    "#Standalone action",
  );
  await expect(row.locator(".task-native-properties")).toContainText(
    "#Committed",
  );
  await expect(row.locator(".task-native-properties")).toContainText(
    "Apr 22, 2040",
  );
  await expect(row.locator(".task-real-labels")).toHaveText(`#${label.title}`);
  expect(await row.boundingBox()).toEqual(before);
  expect(await row.locator(".task-real-labels").boundingBox()).toEqual(
    labelBefore,
  );
  await row
    .getByRole("button", {
      name: `Expand subtasks for ${parent.title}`,
      exact: true,
    })
    .click();
  const children = page.getByRole("list", {
    name: `Subtasks of ${parent.title}`,
    exact: true,
  });
  await expect(children.locator(".task-native-properties")).toContainText(
    "#Routine",
  );
  expect(batches).toEqual([[parent.id, sibling.id], [child.id]]);
  const persisted = await (
    await request.get(`/api/tasks/v1/tasks/${parent.id}`)
  ).json();
  expect(persisted.label_ids).toEqual([label.id]);
});
