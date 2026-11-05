import { expect, test } from "@playwright/test";
import { createResource } from "./seed";

test.use({ serviceWorkers: "block" });

test("a deep-linked task waits for its project and selected labels before opening", async ({
  page,
  request,
}) => {
  const suffix = crypto.randomUUID();
  const project = await createResource(request, "projects", {
    title: `Synthetic ready project ${suffix}`,
  });
  const label = await createResource(request, "labels", {
    title: `Synthetic selected label ${suffix}`,
  });
  const task = await createResource(request, "tasks", {
    title: `Synthetic catalog task ${suffix}`,
    project_id: project.id,
    label_ids: [label.id],
  });
  let releaseCatalog!: () => void;
  const catalogReady = new Promise<void>((resolve) => {
    releaseCatalog = resolve;
  });
  await page.route("**/api/tasks/v1/catalog", async (route) => {
    await catalogReady;
    await route.continue();
  });
  let releaseDetail!: () => void;
  const detailReady = new Promise<void>((resolve) => {
    releaseDetail = resolve;
  });
  await page.route(`**/api/tasks/v1/tasks/${task.id}`, async (route) => {
    await detailReady;
    await route.continue();
  });
  const detailRead = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      new URL(response.url()).pathname === `/api/tasks/v1/tasks/${task.id}`,
  );
  await page.goto(`/?task=${task.id}#/inbox`);
  releaseDetail();
  await (await detailRead).finished();
  // The editor is part of the first load, so two frames give React the time to open it.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  try {
    expect(await dialog.count()).toBe(0);
  } finally {
    releaseCatalog();
  }
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Project", exact: true }),
  ).toHaveText(project.title);
  await expect(dialog.locator(".selected-label")).toHaveText(label.title);
  await expect(dialog.getByText("Edit labels", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Add labels", { exact: true })).toHaveCount(0);
});

test("Edit project waits for catalog metadata instead of opening a new-project form", async ({
  page,
  request,
}) => {
  const project = await createResource(request, "projects", {
    title: `Synthetic cold project edit ${crypto.randomUUID()}`,
  });
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/tasks/v1/catalog", async (route) => {
    await ready;
    await route.continue();
  });
  await page.goto(`/#/project/${project.id}`);
  const edit = page.getByRole("button", { name: "Edit project", exact: true });
  try {
    await expect(edit).toBeDisabled();
  } finally {
    release();
  }
  await expect(edit).toBeEnabled();
  await edit.click();
  const dialog = page.getByRole("dialog", {
    name: "Edit project",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("textbox", { name: "Name", exact: true }),
  ).toHaveValue(project.title);
  await expect(
    dialog.getByRole("checkbox", { name: "Archived", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog", { name: "Add project", exact: true }),
  ).toHaveCount(0);
});
