import { expect, test, type Page } from "@playwright/test";
import { createTask } from "./planning-stub";

test.use({ serviceWorkers: "block" });

function taskWrites(page: Page) {
  const writes: { method: string; path: string }[] = [];
  page.on("request", (event) => {
    const path = new URL(event.url()).pathname;
    if (path.startsWith("/api/tasks/v1/tasks/") && event.method() !== "GET")
      writes.push({ method: event.method(), path });
  });
  return writes;
}

test("editor deletion uses native Enter once and Escape keeps the unsaved task open", async ({
  page,
  request,
}) => {
  const task = await createTask(request, {
    title: `Synthetic keyboard delete ${crypto.randomUUID()}`,
  });
  const writes = taskWrites(page);
  await page.goto(`/?task=${task.id}#/inbox`);
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  const title = dialog.getByRole("textbox", { name: "Task name", exact: true });
  await title.fill("Synthetic unsaved title");
  const trigger = dialog.getByRole("button", { name: "Delete", exact: true });
  const confirm = dialog.getByRole("button", {
    name: "Delete task",
    exact: true,
  });
  await trigger.click();
  await expect(confirm).toBeFocused();
  await title.press("Enter");
  expect(writes).toEqual([]);
  await title.fill("Synthetic unsaved title");
  await confirm.focus();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(title).toHaveValue("Synthetic unsaved title");
  expect(writes).toEqual([]);

  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    started = resolve;
  });
  await page.route(`**/api/tasks/v1/tasks/${task.id}?**`, async (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    started();
    await held;
    await route.continue();
  });
  await trigger.click();
  await expect(confirm).toBeFocused();
  await page.keyboard.down("Enter");
  await requested;
  await expect(confirm).toBeDisabled();
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  expect(writes).toEqual([
    { method: "DELETE", path: `/api/tasks/v1/tasks/${task.id}` },
  ]);
  release();
  await expect(dialog).toHaveCount(0);
  expect((await request.get(`/api/tasks/v1/tasks/${task.id}`)).status()).toBe(
    404,
  );
});

for (const origin of ["context", "more"] as const) {
  test(`${origin} deletion focuses Delete for Enter and cancels with Escape`, async ({
    page,
    request,
  }) => {
    const task = await createTask(request, {
      title: `Synthetic ${origin} keyboard delete ${crypto.randomUUID()}`,
    });
    const writes = taskWrites(page);
    await page.goto("/#/inbox");
    const row = page.locator(".task-row").filter({
      has: page.getByText(task.title, { exact: true }),
    });
    const open = async () => {
      if (origin === "context") await row.click({ button: "right" });
      else
        await row
          .getByRole("button", {
            name: `More actions for ${task.title}`,
            exact: true,
          })
          .click();
      await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    };
    await open();
    const dialog = page.getByRole("dialog", {
      name: "Delete task",
      exact: true,
    });
    const confirm = dialog.getByRole("button", {
      name: "Delete task",
      exact: true,
    });
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(row).toBeVisible();
    expect(writes).toEqual([]);
    await open();
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveCount(0);
    expect(writes).toEqual([
      { method: "DELETE", path: `/api/tasks/v1/tasks/${task.id}` },
    ]);
    expect((await request.get(`/api/tasks/v1/tasks/${task.id}`)).status()).toBe(
      404,
    );
  });
}

test("inline Subtask and Step confirmations keep Enter away from the parent Save", async ({
  page,
  request,
}) => {
  const parent = await createTask(request, {
    title: `Synthetic keyboard parent ${crypto.randomUUID()}`,
  });
  const children = [
    await createTask(request, {
      title: `Synthetic keyboard subtask ${crypto.randomUUID()}`,
      parent_id: parent.id,
    }),
    await createTask(request, {
      title: `Synthetic keyboard step ${crypto.randomUUID()}`,
      parent_id: parent.id,
      kind: "step",
    }),
  ];
  const writes = taskWrites(page);
  await page.goto(`/?task=${parent.id}#/inbox`);
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  const title = dialog.getByRole("textbox", { name: "Task name", exact: true });
  await title.fill("Synthetic parent draft to keep");
  for (const [index, child] of children.entries()) {
    const kind = index ? "step" : "subtask";
    const trigger = dialog.getByRole("button", {
      name: `Delete ${kind} ${child.title}`,
      exact: true,
    });
    const confirm = dialog.getByRole("button", {
      name: `Delete ${kind}`,
      exact: true,
    });
    await trigger.click();
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(confirm).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(title).toHaveValue("Synthetic parent draft to keep");
    await trigger.click();
    await expect(confirm).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveCount(0);
    await expect(title).toHaveValue("Synthetic parent draft to keep");
    expect(
      (await request.get(`/api/tasks/v1/tasks/${child.id}`)).status(),
    ).toBe(404);
  }
  expect(writes).toEqual(
    children.map((child) => ({
      method: "DELETE",
      path: `/api/tasks/v1/tasks/${child.id}`,
    })),
  );
  expect(
    (await (await request.get(`/api/tasks/v1/tasks/${parent.id}`)).json())
      .title,
  ).toBe(parent.title);
});

test("a failed delete refocuses its confirmation for a keyboard retry", async ({
  page,
  request,
}) => {
  const task = await createTask(request, {
    title: `Synthetic keyboard retry ${crypto.randomUUID()}`,
  });
  await page.goto(`/?task=${task.id}#/inbox`);
  let failed = false;
  await page.route(`**/api/tasks/v1/tasks/${task.id}?**`, async (route) => {
    if (route.request().method() !== "DELETE" || failed)
      return route.fallback();
    failed = true;
    await route.fulfill({ status: 503, body: "" });
  });
  const dialog = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await dialog.getByRole("button", { name: "Delete", exact: true }).click();
  const confirm = dialog.getByRole("button", {
    name: "Delete task",
    exact: true,
  });
  await page.keyboard.press("Enter");
  await expect(
    dialog.getByRole("alert").filter({ hasText: "Could not confirm" }),
  ).toBeVisible();
  await expect(confirm).toBeFocused();
  expect((await request.get(`/api/tasks/v1/tasks/${task.id}`)).status()).toBe(
    200,
  );
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect((await request.get(`/api/tasks/v1/tasks/${task.id}`)).status()).toBe(
    404,
  );
});
