import { expect, test, type APIRequestContext } from "@playwright/test";
import { readTodofy, seedMail } from "./planning-stub";

const ORIGIN = "http://127.0.0.1:8798";

async function write(request: APIRequestContext, path: string, data: unknown) {
  const csrf = await (await request.get("/api/tasks/csrf")).json();
  const response = await request.post(path, {
    headers: { "x-csrf-token": csrf.token, origin: ORIGIN },
    data,
  });
  expect(response.status()).toBe(200);
  return response.json();
}
const search = async (request: APIRequestContext, title: string) =>
  (
    await (
      await request.get(
        `/api/tasks/v1/tasks?view=search&include_description=true&query=${encodeURIComponent(title)}`,
      )
    ).json()
  ).tasks ?? [];

test("native mail creates no task until requested, replays a lost reply and deletes only mail", async ({
  page,
  request,
}) => {
  const linked = await write(
    request,
    `/api/tasks/v1/tasks?request_id=${crypto.randomUUID()}`,
    { title: "Synthetic existing linked task" },
  );
  const eventId = crypto.randomUUID();
  const oldEvent = crypto.randomUUID();
  const title = `Synthetic native mail without a task ${eventId.slice(0, 8)}`;
  await seedMail([
    {
      id: eventId,
      title,
      summary:
        "The full synthetic email summary.\nNo task has been created yet.",
      receivedAt: Date.parse("2026-10-17T12:30:00Z"),
    },
    {
      id: oldEvent,
      title: "Synthetic mail with an existing task",
      taskId: linked.id,
    },
  ]);
  const fileBodies: Record<string, unknown>[] = [];
  const forbidden: string[] = [];
  let delayRead = false;
  let finishRead: (() => void) | undefined;
  page.on("request", (sent) => {
    // Mail reads neither Plan nor Focus to find mail.
    if (/\/api\/tasks\/v1\/(?:plan(?:\?|$)|focus)/.test(sent.url()))
      forbidden.push(sent.url());
  });
  await page.route("**/api/mail/v1/mailItems?*", async (route) => {
    if (delayRead)
      await new Promise<void>((resolve) => {
        finishRead = resolve;
      });
    return route.continue();
  });
  // Tasks makes the task and marks the mail; the first answer is lost on the way back.
  await page.route("**/api/tasks/v1/mailItems:convert", async (route) => {
    fileBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (fileBodies.length > 1) return route.continue();
    await route.fetch();
    return route.abort("failed");
  });
  await page.goto("/#/mail");
  const first = page.locator(".native-mail-item").filter({ hasText: title });
  await expect(
    first.getByRole("button", { name: "Create task", exact: true }),
  ).toBeVisible();
  expect(await search(request, title)).toEqual([]);
  await first
    .getByRole("button", { name: /^Synthetic native mail without a task/ })
    .click();
  await expect(first).toContainText("The full synthetic email summary.");
  delayRead = true;
  await page.getByRole("button", { name: "Refresh mail" }).click();
  await expect(first).toBeVisible();
  await expect.poll(() => Boolean(finishRead)).toBe(true);
  finishRead?.();
  delayRead = false;
  await expect(
    page.getByRole("button", { name: "Refresh mail" }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 360, height: 740 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await first.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await first.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(first).toHaveCount(0);
  expect(fileBodies).toHaveLength(2);
  expect(fileBodies[1]).toEqual(fileBodies[0]);
  const [persisted, ...more] = await search(request, title);
  expect(more).toEqual([]);
  expect(persisted.description).toContain(`Mail Hero event: ${eventId}`);
  expect((await readTodofy()).mail[0]).toMatchObject({
    id: eventId,
    pending: false,
    taskId: persisted.id,
  });
  await page
    .getByRole("button", {
      name: "Delete mail Synthetic mail with an existing task",
      exact: true,
    })
    .click();
  const confirm = page.getByRole("dialog", {
    name: "Delete email?",
    exact: true,
  });
  await expect(confirm).toContainText("Existing tasks stay.");
  await confirm
    .getByRole("button", { name: "Delete mail", exact: true })
    .click();
  await expect(
    page.getByText("No mail to review", { exact: true }),
  ).toBeVisible();
  expect((await readTodofy()).mail.map((mail) => mail.id)).toEqual([eventId]);
  expect((await request.get(`/api/tasks/v1/tasks/${linked.id}`)).status()).toBe(
    200,
  );
  expect(forbidden).toEqual([]);
});

test("a definite mail conflict permits a fresh request after refresh, with the saved category", async ({
  page,
  request,
}) => {
  const labelTitle = `SyntheticMailShortcut${crypto.randomUUID().slice(0, 6)}`;
  const label = await write(
    request,
    `/api/tasks/v1/labels?request_id=${crypto.randomUUID()}`,
    { title: labelTitle },
  );
  const eventId = crypto.randomUUID();
  const mail = { id: eventId, title: "Synthetic conflicting email" };
  await seedMail([mail]);
  const bodies: Record<string, unknown>[] = [];
  page.on("request", (sent) => {
    if (sent.url().endsWith("/api/tasks/v1/mailItems:convert"))
      bodies.push(sent.postDataJSON() as Record<string, unknown>);
  });
  await page.goto("/#/mail");
  await page
    .getByRole("button", { name: "Mail categories", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Mail categories",
    exact: true,
  });
  await settings
    .getByRole("button", { name: "Add a category", exact: true })
    .click();
  await settings
    .getByRole("combobox", { name: "Label 1", exact: true })
    .selectOption(label.id);
  await settings
    .getByRole("combobox", { name: "Priority 1", exact: true })
    .selectOption("2");
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings).not.toBeVisible();
  const shortcut = page.getByRole("button", {
    name: `${labelTitle} · P2`,
    exact: true,
  });
  await expect(shortcut).toBeVisible();
  // Reopened, the dialog reads the saved set from Tasks.
  await page
    .getByRole("button", { name: "Mail categories", exact: true })
    .click();
  await expect(
    settings.getByRole("combobox", { name: "Label 1", exact: true }),
  ).toHaveValue(label.id);
  await expect(
    settings.getByRole("combobox", { name: "Priority 1", exact: true }),
  ).toHaveValue("2");
  await page.keyboard.press("Escape");
  await expect(settings).not.toBeVisible();
  // The mail changes in Todofy after the page read it.
  await seedMail([{ ...mail, version: 1 }]);
  await shortcut.click();
  await expect(page.getByRole("alert")).toContainText("changed");
  await page.getByRole("button", { name: "Refresh mail" }).click();
  await expect(
    page.getByRole("button", { name: "Refresh mail" }),
  ).toBeEnabled();
  await shortcut.click();
  await expect(
    page.getByText("No mail to review", { exact: true }),
  ).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[0]?.etag).not.toBe(bodies[1]?.etag);
  expect(bodies[0]?.request_id).not.toBe(bodies[1]?.request_id);
  const [converted] = (await readTodofy()).mail;
  const task = await (
    await request.get(`/api/tasks/v1/tasks/${String(converted?.taskId)}`)
  ).json();
  expect(task).toMatchObject({
    title: "Synthetic conflicting email",
    label_ids: [label.id],
    priority: 2,
  });
});

test("a filed email summary remains accessible by its link after leaving pending Mail", async ({
  page,
}) => {
  const id = crypto.randomUUID();
  const fullSummary =
    "Synthetic full detail.\n".repeat(900) +
    "This final paragraph was beyond the task copy.";
  await seedMail([
    {
      id,
      title: "Synthetic filed mail",
      summary: fullSummary,
      pending: false,
      taskId: "synthetic-filed-task",
    },
  ]);
  await page.goto(`/?mail=${id}#/mail`);
  const summary = page.getByRole("dialog", {
    name: "Mail summary",
    exact: true,
  });
  await expect(summary).toContainText(
    "This final paragraph was beyond the task copy.",
  );
  await expect(page.locator(".native-mail-item")).toHaveCount(0);
  await summary.getByRole("button", { name: "Close", exact: true }).click();
  await expect(summary).not.toBeVisible();
  expect(new URL(page.url()).searchParams.has("mail")).toBe(false);
  expect(new URL(page.url()).hash).toBe("#/mail");
});
