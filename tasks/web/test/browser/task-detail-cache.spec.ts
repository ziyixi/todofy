import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

test.use({ serviceWorkers: "block" });

interface Task {
  id: string;
  title: string;
  etag: string;
}
async function make(
  request: APIRequestContext,
  title: string,
  description = "",
): Promise<Task> {
  const { token } = await (await request.get("/api/tasks/csrf")).json();
  const response = await request.post(
    `/api/tasks/v1/tasks?request_id=${crypto.randomUUID()}`,
    {
      headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
      data: { title, description },
    },
  );
  expect(response.status(), await response.text()).toBe(200);
  return response.json();
}
async function externalRename(
  request: APIRequestContext,
  id: string,
  title: string,
) {
  const current = (await (
    await request.get(`/api/tasks/v1/tasks/${id}`)
  ).json()) as Task;
  const { token } = await (await request.get("/api/tasks/csrf")).json();
  const response = await request.patch(
    `/api/tasks/v1/tasks/${id}?request_id=${crypto.randomUUID()}&etag=${current.etag}&update_mask=title`,
    {
      headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
      data: { title },
    },
  );
  expect(response.status(), await response.text()).toBe(200);
}
async function plan(page: Page) {
  await page.route("**/api/plus/v1/plan:read", (route) =>
    route.fulfill({
      json: { plan: { native_planning: true, dependencies: [] } },
    }),
  );
  await page.route("**/api/plus/v1/tasks?**", (route) => {
    const id = new URL(route.request().url()).searchParams.get("task_ids");
    return route.fulfill({
      json: {
        planning_tasks: [
          {
            id,
            etag: "synthetic-detail-cache",
            explicit_stage: "none",
            area: "unassigned",
          },
        ],
      },
    });
  });
}
async function open(page: Page, title: string) {
  await page.getByText(title, { exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("only a full detail reply seeds reopening; own writes and focus invalidate it without replacing an edited draft", async ({
  page,
  request,
}) => {
  const title = `Synthetic detail cache ${crypto.randomUUID()}`;
  const description =
    "Full synthetic detail. ".repeat(50) + "Unique full-description tail.";
  const task = await make(request, title, description);
  await plan(page);
  let reads = 0;
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const firstRead = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(`**/api/tasks/v1/tasks/${task.id}`, async (route) => {
    if (route.request().method() === "GET") {
      reads++;
      if (reads === 1) {
        started();
        await held;
      }
    }
    await route.continue();
  });
  await page.goto("/#/inbox");
  await page.getByText(title, { exact: true }).click();
  await firstRead;
  expect(
    await page
      .getByRole("dialog", { name: "Task details", exact: true })
      .count(),
  ).toBe(0);
  release();
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await expect(dialog.locator(".description-preview")).toContainText(
    "Unique full-description tail.",
  );
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await open(page, title);
  await expect(dialog.locator(".description-preview")).toContainText(
    "Unique full-description tail.",
  );
  expect(reads).toBe(1);
  const ownTitle = `${title} edited`;
  await dialog
    .getByRole("textbox", { name: "Task name", exact: true })
    .fill(ownTitle);
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.locator(".task-save-status")).toHaveText("Saved");
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await open(page, ownTitle);
  expect(reads).toBe(2);
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await externalRename(request, task.id, `${title} external`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await open(page, ownTitle);
  await expect(
    dialog.getByRole("textbox", { name: "Task name", exact: true }),
  ).toHaveValue(`${title} external`);
  expect(reads).toBe(3);
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await externalRename(request, task.id, `${title} visibility refresh`);
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await open(page, ownTitle);
  await expect(
    dialog.getByRole("textbox", { name: "Task name", exact: true }),
  ).toHaveValue(`${title} visibility refresh`);
  expect(reads).toBe(4);
  const unsaved = `${title} unsaved draft`;
  await dialog
    .getByRole("textbox", { name: "Task name", exact: true })
    .fill(unsaved);
  await externalRename(request, task.id, `${title} newer external`);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    dialog.getByRole("textbox", { name: "Task name", exact: true }),
  ).toHaveValue(unsaved);
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("Resource changed");
  await expect(
    dialog.getByRole("textbox", { name: "Task name", exact: true }),
  ).toHaveValue(unsaved);
  const current = (await (
    await request.get(`/api/tasks/v1/tasks/${task.id}`)
  ).json()) as Task;
  expect(current.title).toBe(`${title} newer external`);
});

test("a slower earlier task read cannot replace the task opened most recently", async ({
  page,
  request,
}) => {
  const first = await make(
    request,
    `Synthetic first slow ${crypto.randomUUID()}`,
  );
  const second = await make(
    request,
    `Synthetic second quick ${crypto.randomUUID()}`,
  );
  await plan(page);
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(`**/api/tasks/v1/tasks/${first.id}`, async (route) => {
    started();
    await held;
    await route.continue();
  });
  await page.goto("/#/inbox");
  await page.getByText(first.title, { exact: true }).click();
  await requested;
  const dialog = await open(page, second.title);
  const response = page.waitForResponse(
    (value) =>
      new URL(value.url()).pathname === `/api/tasks/v1/tasks/${first.id}`,
  );
  release();
  await (await response).finished();
  await page.evaluate(
    () => new Promise((resolve) => window.requestAnimationFrame(resolve)),
  );
  await expect(
    dialog.getByRole("textbox", { name: "Task name", exact: true }),
  ).toHaveValue(second.title);
});
