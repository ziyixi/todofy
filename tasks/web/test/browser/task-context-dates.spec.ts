import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

test.use({ serviceWorkers: "block", timezoneId: "UTC" });

async function createTask(
  request: APIRequestContext,
  fields: Record<string, unknown>,
) {
  const { token } = await (await request.get("/api/tasks/csrf")).json();
  const response = await request.post(
    `/api/tasks/v1/tasks?request_id=${crypto.randomUUID()}`,
    {
      headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
      data: fields,
    },
  );
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<{ id: string; title: string }>;
}
async function openDateMenu(
  page: Page,
  title: string,
  property: "date" | "deadline",
) {
  const row = page
    .locator(".task-row")
    .filter({ has: page.getByText(title, { exact: true }) });
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: "right" });
  await page
    .getByRole("menuitem", {
      name: property === "deadline" ? "Deadline" : "More dates",
      exact: true,
    })
    .click();
  return page.getByRole("dialog", {
    name: property === "deadline" ? "Deadline picker" : "Date picker",
    exact: true,
  });
}

test("context date input saves calendar dates while Steps stay out of ordinary search", async ({
  page,
  request,
}) => {
  const task = await createTask(request, {
    title: `Synthetic context date ${crypto.randomUUID()}`,
  });
  const step = await createTask(request, {
    title: `Synthetic context step ${crypto.randomUUID()}`,
    parent_id: task.id,
    kind: "step",
  });
  await page.goto("/#/inbox");
  const date = await openDateMenu(page, task.title, "date");
  await date
    .getByRole("textbox", { name: "Schedule", exact: true })
    .fill("2044-04-08 at 09:30");
  await date.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(date).not.toBeVisible();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Date saved. Set a time on a Step" }),
  ).toBeVisible();
  const saved = await (
    await request.get(`/api/tasks/v1/tasks/${task.id}`)
  ).json();
  expect(saved.due_date).toBe("2044-04-08");
  expect(saved.due_datetime || "").toBe("");
  expect(saved.due_timezone || "").toBe("");

  await page.goto("/#/search");
  await page
    .getByRole("textbox", { name: "Search tasks", exact: true })
    .fill(step.title);
  await expect(
    page.getByText("No matching tasks", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(step.title, { exact: true })).toHaveCount(0);
  const retained = await (
    await request.get(`/api/tasks/v1/tasks/${step.id}`)
  ).json();
  expect(retained.kind).toBe("step");
  expect(retained.parent_id).toBe(task.id);
});

test("clearing a deadline through its context menu clears its start-ahead days in the same write", async ({
  page,
  request,
}) => {
  const task = await createTask(request, {
    title: `Synthetic context deadline ${crypto.randomUUID()}`,
    deadline: "2044-04-08",
    lead_days: 14,
  });
  const writes: string[] = [];
  page.on("request", (event) => {
    if (event.method() !== "GET") writes.push(new URL(event.url()).pathname);
  });
  await page.goto("/#/inbox");
  const deadline = await openDateMenu(page, task.title, "deadline");
  await deadline
    .getByRole("button", { name: "No deadline", exact: true })
    .click();
  await expect(deadline).not.toBeVisible();
  await expect.poll(() => writes).toEqual([`/api/tasks/v1/tasks/${task.id}`]);
  const saved = await (
    await request.get(`/api/tasks/v1/tasks/${task.id}`)
  ).json();
  expect(saved.deadline || "").toBe("");
  expect(saved.lead_days ?? 0).toBe(0);
});
