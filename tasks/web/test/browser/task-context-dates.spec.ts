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

test("clearing a deadline through its context menu clears native start-ahead after the D1 write", async ({
  page,
  request,
}) => {
  const task = await createTask(request, {
    title: `Synthetic context deadline ${crypto.randomUUID()}`,
    deadline: "2044-04-08",
  });
  let leadDays = 14;
  let reads = 0;
  await page.route("**/api/plus/v1/tasks?**", async (route) => {
    reads++;
    const current = await (
      await request.get(`/api/tasks/v1/tasks/${task.id}`)
    ).json();
    expect(current.deadline || "").toBe("");
    await route.fulfill({
      json: {
        planning_tasks: [
          {
            id: task.id,
            title: task.title,
            lead_days: leadDays,
            etag: "fresh-context-planning",
          },
        ],
      },
    });
  });
  await page.route("**/api/plus/v1/tasks:setTaskLead", async (route) => {
    const input = route.request().postDataJSON() as {
      task_id: string;
      deadline?: string;
      lead_days?: number;
      etag: string;
    };
    expect(input.task_id).toBe(task.id);
    expect(input.etag).toBe("fresh-context-planning");
    expect(input.deadline || "").toBe("");
    leadDays = input.lead_days || 0;
    await route.fulfill({
      json: {
        task: {
          id: task.id,
          title: task.title,
          etag: "updated-context-planning",
        },
      },
    });
  });
  await page.goto("/#/inbox");
  expect(reads).toBe(0);
  const deadline = await openDateMenu(page, task.title, "deadline");
  await deadline
    .getByRole("button", { name: "No deadline", exact: true })
    .click();
  await expect(deadline).not.toBeVisible();
  await expect.poll(() => leadDays).toBe(0);
  expect(reads).toBe(1);
  const saved = await (
    await request.get(`/api/tasks/v1/tasks/${task.id}`)
  ).json();
  expect(saved.deadline || "").toBe("");
});
