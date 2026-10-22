import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
} from "@playwright/test";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });

async function createTask(request: APIRequestContext, description: string) {
  const { token } = await (await request.get("/api/tasks/csrf")).json();
  const response = await request.post(
    `/api/tasks/v1/tasks?request_id=${crypto.randomUUID()}`,
    {
      headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
      data: {
        title: `Synthetic editor feedback ${crypto.randomUUID()}`,
        description,
        kind: "task",
      },
    },
  );
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<{
    id: string;
    title: string;
    etag: string;
  }>;
}

async function geometry(dialog: Locator) {
  return {
    dialog: await dialog.boundingBox(),
    footer: await dialog.locator(".dialog-footer").boundingBox(),
    button: await dialog
      .getByRole("button", { name: "Save changes", exact: true })
      .boundingBox(),
    properties: await dialog.locator(".task-properties").boundingBox(),
    planning: await dialog
      .getByRole("region", { name: "Task planning", exact: true })
      .boundingBox(),
    body: await dialog.locator(".task-edit-body").evaluate((body) => ({
      height: body.clientHeight,
      scroll: body.scrollHeight,
      top: body.scrollTop,
    })),
  };
}

test("description Done persists one task write and reopens as Markdown without another Save", async ({
  page,
  request,
}, testInfo) => {
  const task = await createTask(
    request,
    "Read [the guide](https://example.org/guide).",
  );
  await page.goto(`/?task=${task.id}#/inbox`);
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  const description = dialog.getByRole("region", {
    name: "Task description",
    exact: true,
  });
  await expect(
    description.getByRole("link", { name: "the guide", exact: true }),
  ).toBeVisible();
  await expect(description.locator(".description-loading")).toHaveCount(0);
  let release!: () => void;
  let requested!: () => void;
  const pending = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let writes = 0;
  await page.route(`**/api/tasks/v1/tasks/${task.id}?**`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    writes++;
    requested();
    await hold;
    await route.continue();
  });
  await description
    .getByRole("button", { name: "Edit description", exact: true })
    .click();
  const input = description.getByRole("textbox", {
    name: "Description",
    exact: true,
  });
  const markdown =
    "## Saved description\n\n**Complete draft** and [the guide](https://example.org/saved).\n\n- First saved item\n- Second saved item\n\nhttps://example.org/source\n\n![Omitted image](https://example.org/remote.png)";
  await input.fill(markdown);
  await dialog
    .getByRole("combobox", { name: "Planning stage", exact: true })
    .selectOption("weekly");
  const done = description.getByRole("button", { name: "Done", exact: true });
  await done.click();
  await pending;
  await expect(input).toBeVisible();
  await expect(input).toBeDisabled();
  await expect(
    dialog.getByRole("textbox", { name: "Task name", exact: true }),
  ).toBeDisabled();
  await expect(done).toBeDisabled();
  await expect(dialog.locator(".task-save-status")).toHaveText("");
  release();
  await expect(input).toHaveCount(0);
  await expect(
    dialog.getByRole("textbox", { name: "Task name", exact: true }),
  ).toBeEnabled();
  await expect(dialog.locator(".task-save-status")).toHaveText("Saved");
  const saved = await (
    await request.get(`/api/tasks/v1/tasks/${task.id}`)
  ).json();
  expect(saved.description).toBe(markdown);
  expect(saved.stage).toBe("weekly");
  expect(writes).toBe(1);
  await expect(
    description.getByRole("heading", {
      name: "Saved description",
      exact: true,
    }),
  ).toBeVisible();
  await expect(description.locator("strong")).toHaveText("Complete draft");
  await expect(description.getByRole("listitem")).toHaveText([
    "First saved item",
    "Second saved item",
  ]);
  await expect(description.locator("img")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("task-description-done-saved.png"),
  });
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page.getByText(task.title, { exact: true }).click();
  await expect(
    description.getByRole("heading", {
      name: "Saved description",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    description.getByRole("link", { name: "the guide", exact: true }),
  ).toHaveAttribute("href", "https://example.org/saved");
  await expect(description.getByRole("textbox")).toHaveCount(0);
  await expect(description.locator(".description-loading")).toHaveCount(0);
  const frames = await dialog.evaluate(async (element) => {
    const snapshots: unknown[] = [];
    for (let frame = 0; frame < 8; frame++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const section = element
        .querySelector(".task-planning-fields")!
        .getBoundingClientRect();
      const body = element.querySelector(".task-edit-body")!;
      snapshots.push({
        top: section.top,
        height: section.height,
        scroll: body.scrollTop,
      });
    }
    return snapshots;
  });
  expect(new Set(frames.map((frame) => JSON.stringify(frame))).size).toBe(1);
  expect(writes).toBe(1);
});

test("failed Done keeps its description draft open and reports no Saved state", async ({
  page,
  request,
}) => {
  const task = await createTask(request, "Original saved description.");
  await page.goto(`/?task=${task.id}#/inbox`);
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  const description = dialog.getByRole("region", {
    name: "Task description",
    exact: true,
  });
  await page.route(`**/api/tasks/v1/tasks/${task.id}?**`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await route.fulfill({ status: 503, body: "" });
  });
  await description
    .getByRole("button", { name: "Edit description", exact: true })
    .click();
  const input = description.getByRole("textbox", {
    name: "Description",
    exact: true,
  });
  await input.fill("**Unsaved draft to keep**");
  await description.getByRole("button", { name: "Done", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Could not confirm");
  await expect(input).toHaveValue("**Unsaved draft to keep**");
  await expect(input).toBeEnabled();
  await expect(
    description.getByRole("button", { name: "Done", exact: true }),
  ).toBeEnabled();
  await expect(dialog.locator(".task-save-status")).toHaveText("");
  await expect(
    dialog.getByRole("button", { name: "Save changes", exact: true }),
  ).toHaveText("Save changes");
  const saved = await (
    await request.get(`/api/tasks/v1/tasks/${task.id}`)
  ).json();
  expect(saved.description).toBe("Original saved description.");
  expect(saved.etag).toBe(task.etag);
});

test("Save shows a stable Saved confirmation until an edit and keeps the cached editor geometry", async ({
  page,
  request,
}, testInfo) => {
  const task = await createTask(
    request,
    "## Synthetic saved notes\n\n[Read the guide](https://example.org/guide).\n\n" +
      Array.from(
        { length: 14 },
        (_, index) => `- Synthetic saved item ${String(index + 1)}`,
      ).join("\n"),
  );
  await page.goto(`/?task=${task.id}#/inbox`);
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await expect(
    dialog.getByRole("heading", { name: "Synthetic saved notes", exact: true }),
  ).toBeVisible();
  const title = dialog.getByRole("textbox", { name: "Task name", exact: true });
  const changedTitle = `${task.title} saved`;
  await title.fill(changedTitle);
  await dialog.locator(".task-edit-body").evaluate((body) => {
    body.scrollTop = 80;
  });
  const before = await geometry(dialog);
  const saveButton = dialog.getByRole("button", {
    name: "Save changes",
    exact: true,
  });
  await saveButton.click();
  await expect(dialog.locator(".task-save-status")).toHaveText("Saved");
  await expect(saveButton).toHaveText("Saved");
  expect(await geometry(dialog)).toEqual(before);
  // Reading the unchanged description must not remove the confirmation.
  await dialog
    .getByRole("heading", { name: "Synthetic saved notes", exact: true })
    .click();
  await expect(saveButton).toHaveText("Saved");
  expect(await geometry(dialog)).toEqual(before);
  await page.screenshot({
    path: testInfo.outputPath("task-footer-save-confirmation.png"),
  });
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page.getByText(changedTitle, { exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Synthetic saved notes", exact: true }),
  ).toBeVisible();
  await title.fill(`${changedTitle} again`);
  await dialog.locator(".task-edit-body").evaluate((body) => {
    body.scrollTop = 80;
  });
  const reopened = await geometry(dialog);
  await saveButton.click();
  await expect(saveButton).toHaveText("Saved");
  expect(await geometry(dialog)).toEqual(reopened);
  await title.fill(`${changedTitle} draft`);
  await expect(dialog.locator(".task-save-status")).toHaveText("");
  await expect(saveButton).toHaveText("Save changes");
});
