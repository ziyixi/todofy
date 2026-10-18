import { expect, test } from "@playwright/test";

test("saving unchanged task and planning fields writes nothing and does not reload category counts", async ({
  page,
  request,
}) => {
  const { token } = await (await request.get("/api/tasks/csrf")).json();
  const created = await request.post(
    `/api/tasks/v1/tasks?request_id=${crypto.randomUUID()}`,
    {
      headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
      data: {
        title: "Synthetic no-op save",
        description: "Keep the complete description.",
        kind: "task",
      },
    },
  );
  expect(created.status()).toBe(200);
  const task = await created.json();
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
            id: task.id,
            etag: "synthetic-noop",
            kind: "task",
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
