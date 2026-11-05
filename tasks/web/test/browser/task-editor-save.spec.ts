import {
  expect,
  test,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { seedTask, type SeededResource } from "./seed";

test.use({ serviceWorkers: "block", viewport: { width: 1440, height: 1000 } });

async function createTask(
  request: APIRequestContext,
  description: string,
  fields: Record<string, unknown> = {},
) {
  return seedTask(request, {
    title: `Synthetic editor feedback ${crypto.randomUUID()}`,
    description,
    kind: "task",
    ...fields,
  });
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

test("explicit Save closes after confirmation and a cached reopen saves with the fresh baseline", async ({
  page,
  request,
}, testInfo) => {
  const task = await createTask(
    request,
    "## Synthetic saved notes\n\n[Read the guide](https://example.org/guide).",
  );
  let writes = 0;
  page.on("request", (event) => {
    if (
      event.method() === "PATCH" &&
      new URL(event.url()).pathname === `/api/tasks/v1/tasks/${task.id}`
    )
      writes++;
  });
  await page.goto(`/?task=${task.id}#/inbox`);
  const dialog = page.getByRole("dialog", { name: "Task details", exact: true });
  const title = dialog.getByRole("textbox", { name: "Task name", exact: true });
  const changedTitle = `${task.title} saved`;
  await title.fill(changedTitle);
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(page).not.toHaveURL(/task=/u);
  expect(writes).toBe(1);
  expect(
    (await (await request.get(`/api/tasks/v1/tasks/${task.id}`)).json()).title,
  ).toBe(changedTitle);
  await page.getByText(changedTitle, { exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Synthetic saved notes", exact: true }),
  ).toBeVisible();
  const reopened = await geometry(dialog);
  const frames = await dialog.evaluate(async (element) => {
    const snapshots: unknown[] = [];
    for (let frame = 0; frame < 8; frame++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      const bounds = element.getBoundingClientRect();
      const properties = element
        .querySelector(".task-properties")!
        .getBoundingClientRect();
      const body = element.querySelector(".task-edit-body")!;
      snapshots.push({
        top: bounds.top,
        height: bounds.height,
        propertyTop: properties.top,
        scroll: body.scrollTop,
      });
    }
    return snapshots;
  });
  expect(new Set(frames.map((frame) => JSON.stringify(frame))).size).toBe(1);
  expect(await geometry(dialog)).toEqual(reopened);
  await page.screenshot({
    path: testInfo.outputPath("task-save-cached-reopen.png"),
  });
  await title.fill(`${changedTitle} again`);
  await title.press("Control+Enter");
  await expect(dialog).toHaveCount(0);
  expect(writes).toBe(2);
  expect(
    (await (await request.get(`/api/tasks/v1/tasks/${task.id}`)).json()).title,
  ).toBe(`${changedTitle} again`);
});

test("failed explicit Save keeps the task draft open", async ({
  page,
  request,
}) => {
  const task = await createTask(request, "Synthetic original description.");
  await page.goto(`/?task=${task.id}#/inbox`);
  const dialog = page.getByRole("dialog", { name: "Task details", exact: true });
  await page.route(`**/api/tasks/v1/tasks/${task.id}?**`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    await route.fulfill({ status: 503, body: "" });
  });
  const title = dialog.getByRole("textbox", { name: "Task name", exact: true });
  await title.fill("Synthetic unsaved title");
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText("Could not confirm");
  await expect(title).toHaveValue("Synthetic unsaved title");
  await expect(title).toBeEnabled();
  expect(
    (await (await request.get(`/api/tasks/v1/tasks/${task.id}`)).json()).title,
  ).toBe(task.title);
});

test("a delayed child Save cannot replace the task opened after closing its editor", async ({
  page,
  request,
}) => {
  const parent = await createTask(request, "Synthetic previous parent.");
  const child = await createTask(request, "Synthetic delayed child.", {
    parent_id: parent.id,
  });
  const other = await createTask(request, "Synthetic next task.");
  let parentReads = 0;
  page.on("request", (event) => {
    if (
      event.method() === "GET" &&
      new URL(event.url()).pathname === `/api/tasks/v1/tasks/${parent.id}`
    )
      parentReads++;
  });
  await page.goto(`/?task=${parent.id}#/inbox`);
  const dialog = page.getByRole("dialog", { name: "Task details", exact: true });
  await dialog.getByRole("button", { name: child.title, exact: true }).click();
  await expect(dialog.getByRole("textbox", { name: "Task name", exact: true })).toHaveValue(child.title);
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(`**/api/tasks/v1/tasks/${child.id}?**`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    started();
    await held;
    await route.continue();
  });
  await dialog
    .getByRole("textbox", { name: "Task name", exact: true })
    .fill(`${child.title} saved late`);
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await requested;
  await dialog
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await page.getByText(other.title, { exact: true }).click();
  const title = dialog.getByRole("textbox", { name: "Task name", exact: true });
  await expect(title).toHaveValue(other.title);
  release();
  await expect(page.locator(".notice")).toContainText("Task saved");
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(title).toHaveValue(other.title);
  expect(parentReads).toBe(1);
  expect(
    (await (await request.get(`/api/tasks/v1/tasks/${child.id}`)).json()).title,
  ).toBe(`${child.title} saved late`);
});

test("saving a Step returns to its Subtask, then saving the Subtask returns to its parent", async ({
  page,
  request,
}, testInfo) => {
  const parent = await createTask(request, "Synthetic parent notes.");
  const child = await createTask(request, "Synthetic child notes.", {
    parent_id: parent.id,
  });
  const step = await createTask(request, "Synthetic step notes.", {
    parent_id: child.id,
    kind: "step",
  });
  const writes: string[] = [];
  const reads: string[] = [];
  page.on("request", (event) => {
    const path = new URL(event.url()).pathname;
    if (!path.startsWith("/api/tasks/v1/tasks/")) return;
    if (event.method() === "PATCH") writes.push(path);
    if (event.method() === "GET") reads.push(path);
  });
  await page.goto(`/?task=${parent.id}#/inbox`);
  const taskDialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await taskDialog.getByRole("button", { name: child.title, exact: true }).click();
  await expect(
    taskDialog.getByRole("textbox", { name: "Task name", exact: true }),
  ).toHaveValue(child.title);
  await taskDialog.getByRole("button", { name: step.title, exact: true }).click();
  const stepDialog = page.getByRole("dialog", {
    name: "Step details",
    exact: true,
  });
  await stepDialog
    .getByRole("textbox", { name: "Task name", exact: true })
    .fill(`${step.title} saved`);
  await stepDialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(stepDialog).toHaveCount(0);
  await expect(
    taskDialog.getByRole("textbox", { name: "Task name", exact: true }),
  ).toHaveValue(child.title);
  await expect(
    taskDialog.getByRole("button", {
      name: `${step.title} saved`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await taskDialog
    .getByRole("textbox", { name: "Task name", exact: true })
    .fill(`${child.title} saved`);
  await taskDialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(
    taskDialog.getByRole("textbox", { name: "Task name", exact: true }),
  ).toHaveValue(parent.title);
  await expect(
    taskDialog.getByRole("button", {
      name: `${child.title} saved`,
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("task-save-returned-parent.png"),
  });
  await taskDialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(taskDialog).toHaveCount(0);
  expect(writes).toEqual([
    `/api/tasks/v1/tasks/${step.id}`,
    `/api/tasks/v1/tasks/${child.id}`,
  ]);
  expect(reads.filter((path) => path.endsWith(`/${parent.id}`))).toHaveLength(2);
  expect(reads.filter((path) => path.endsWith(`/${child.id}`))).toHaveLength(2);
});

test("saving unchanged task and planning fields writes nothing and does not reload category counts", async ({
  page,
  request,
}) => {
  const task = await seedTask(request, {
    title: "Synthetic no-op save",
    description: "Keep the complete description.",
    kind: "task",
  });
  let catalogReads = 0;
  let writes = 0;
  page.on("request", (event) => {
    const path = new URL(event.url()).pathname;
    if (path === "/api/tasks/v1/catalog") catalogReads++;
    if (path.startsWith("/api/") && !["GET", "HEAD"].includes(event.method()))
      writes++;
  });
  await page.goto(`/?task=${task.id}#/inbox`);
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await expect(
    dialog.getByRole("combobox", { name: "Planning stage", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".category-count").first()).toBeVisible();
  const readsBefore = catalogReads;
  await dialog
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  const after = await (
    await request.get(`/api/tasks/v1/tasks/${task.id}`)
  ).json();
  expect(after.etag).toBe(task.etag);
  expect(after.description).toBe("Keep the complete description.");
  expect(writes).toBe(0);
  expect(catalogReads).toBe(readsBefore);
});

const DATE_HELP = "YYYY-MM-DD, e.g. 2030-04-15, or tomorrow.";

async function describedDateInput(picker: Locator, name: string) {
  const input = picker.getByRole("textbox", { name, exact: true });
  await expect(input).toHaveAttribute("placeholder", "YYYY-MM-DD or tomorrow");
  await expect(input).toHaveAccessibleDescription(DATE_HELP);
  await expect(picker.getByText(DATE_HELP, { exact: true })).toBeVisible();
  await expect(picker.getByRole("grid")).toBeVisible();
  await expect(
    picker.getByRole("button", { name: /^Tomorrow\b/ }),
  ).toBeVisible();
  return input;
}

test("Date and Deadline explain accepted input in task details and contextual choosers", async ({
  page,
  request,
}) => {
  const task = await seedTask(request, {
    title: `Synthetic date format guidance ${crypto.randomUUID()}`,
  });
  await page.goto(`/?task=${task.id}#/inbox`);
  const details = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await details.getByRole("button", { name: "Date", exact: true }).click();
  const datePicker = page.getByRole("dialog", {
    name: "Date picker",
    exact: true,
  });
  const dateInput = await describedDateInput(datePicker, "Schedule");
  await dateInput.fill("2030-04-15");
  await dateInput.press("Enter");
  await expect(datePicker.getByRole("status")).toHaveText("Next: 2030-04-15");
  await details.getByRole("button", { name: "Date", exact: true }).click();
  await details.getByRole("button", { name: "Deadline", exact: true }).click();
  const deadlinePicker = page.getByRole("dialog", {
    name: "Deadline picker",
    exact: true,
  });
  const deadlineInput = await describedDateInput(
    deadlinePicker,
    "Deadline text",
  );
  await deadlineInput.fill("2030-04-22");
  await deadlineInput.press("Enter");
  await expect(deadlinePicker).not.toBeVisible();
  await details
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await expect(details).not.toBeVisible();
  let saved = await (
    await request.get(`/api/tasks/v1/tasks/${task.id}`)
  ).json();
  expect(saved.due_date).toBe("2030-04-15");
  expect(saved.deadline).toBe("2030-04-22");

  await page.goto("/#/inbox");
  const row = page
    .locator(".task-row")
    .filter({ has: page.getByText(task.title, { exact: true }) });
  await row
    .getByRole("button", {
      name: `More actions for ${task.title}`,
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "More dates", exact: true }).click();
  const contextDateInput = await describedDateInput(datePicker, "Schedule");
  await contextDateInput.fill("2030-04-16");
  await contextDateInput.press("Enter");
  await expect(datePicker).not.toBeVisible();
  saved = await (await request.get(`/api/tasks/v1/tasks/${task.id}`)).json();
  expect(saved.due_date).toBe("2030-04-16");
  expect(saved.deadline).toBe("2030-04-22");

  await row
    .getByRole("button", {
      name: `More actions for ${task.title}`,
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Deadline", exact: true }).click();
  const contextDeadlineInput = await describedDateInput(
    deadlinePicker,
    "Deadline text",
  );
  await contextDeadlineInput.fill("2030-04-30");
  await contextDeadlineInput.press("Enter");
  await expect(deadlinePicker).not.toBeVisible();
  saved = await (await request.get(`/api/tasks/v1/tasks/${task.id}`)).json();
  expect(saved.deadline).toBe("2030-04-30");
  expect(saved.due_date).toBe("2030-04-16");
  await page.reload();
  await row
    .getByRole("button", {
      name: `More actions for ${task.title}`,
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Deadline", exact: true }).click();
  await describedDateInput(deadlinePicker, "Deadline text");
});

async function make(
  request: APIRequestContext,
  title: string,
  description = "",
): Promise<SeededResource> {
  return seedTask(request, { title, description });
}
async function externalRename(
  request: APIRequestContext,
  id: string,
  title: string,
) {
  const current = (await (
    await request.get(`/api/tasks/v1/tasks/${id}`)
  ).json()) as SeededResource;
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
async function open(page: Page, title: string) {
  await page.getByText(title, { exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("the dialog opens on the full GetTask reply, each open reads the task again, and an edited draft outlives an external change until its save is refused", async ({
  page,
  request,
}) => {
  const title = `Synthetic detail read ${crypto.randomUUID()}`;
  const description =
    "Full synthetic detail. ".repeat(50) + "Unique full-description tail.";
  const task = await make(request, title, description);
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
  // No page cache: a change made elsewhere shows on the next open.
  await externalRename(request, task.id, `${title} external`);
  await open(page, title);
  await expect(
    dialog.getByRole("textbox", { name: "Task name", exact: true }),
  ).toHaveValue(`${title} external`);
  expect(reads).toBe(2);
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
  ).json()) as SeededResource;
  expect(current.title).toBe(`${title} newer external`);
  expect(reads).toBe(2);
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

