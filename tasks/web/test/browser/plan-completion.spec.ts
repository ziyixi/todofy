import { expect, test } from "@playwright/test";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("Plan completes an outcome in real D1 and settles its running descendant on the original timer date", async ({
  page,
  request,
}) => {
  const { token } = await (await request.get("/api/tasks/csrf")).json();
  const create = async (value: Record<string, unknown>) => {
    const response = await request.post(
      `/api/tasks/v1/tasks?request_id=${crypto.randomUUID()}`,
      {
        headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
        data: value,
      },
    );
    expect(response.status()).toBe(200);
    return response.json() as Promise<{
      id: string;
      name: string;
      etag: string;
    }>;
  };
  const parent = await create({ title: "Synthetic Plan completion outcome" });
  const child = await create({
    title: "Synthetic running descendant",
    parent_id: parent.id,
    kind: "step",
  });
  const today = "2026-10-13",
    timerDate = "2026-10-12";
  const genericWrites: { requestId: string; etag: string }[] = [];
  page.on("request", (event) => {
    const url = new URL(event.url());
    if (url.pathname !== `/api/tasks/v1/${parent.name}:complete`) return;
    const body = event.postDataJSON() || {};
    genericWrites.push({
      requestId: body.request_id || url.searchParams.get("request_id"),
      etag: body.etag,
    });
  });
  const settlements: Record<string, unknown>[] = [];
  await page.route("**/api/plus/**", async (route) => {
    const url = new URL(route.request().url());
    let response: unknown;
    if (url.pathname.endsWith("/plan:read"))
      response = {
        plan: {
          native_planning: true,
          enabled: true,
          timezone: "UTC",
          week_start: timerDate,
          today,
          etag: "synthetic-plan",
          labels: [],
          available_labels: [],
          dependencies: [],
        },
      };
    else if (url.pathname === "/api/plus/v1/tasks") {
      const tasks = await Promise.all(
        [parent, child].map(async ({ id }) =>
          (await request.get(`/api/tasks/v1/tasks/${id}`)).json(),
        ),
      );
      response = {
        planning_tasks: tasks
          .filter((task) => !task.completed)
          .map((task) => ({
            ...task,
            kind: task.kind || "task",
            etag: "synthetic-planning",
            stage: task.id === parent.id ? "committed" : "none",
            explicit_stage: task.id === parent.id ? "committed" : "none",
            area: "work",
            planning_flags: [],
          })),
      };
    } else if (url.pathname.endsWith("/tasks:completeTask")) {
      const body = route.request().postDataJSON();
      const completed = await (
        await request.get(`/api/tasks/v1/tasks/${child.id}`)
      ).json();
      expect(completed.completed).toBe(true);
      settlements.push(body);
      response = { task_id: parent.id };
    } else if (url.pathname === "/api/plus/flowday/api/v1/timerSession")
      response = settlements.length
        ? { name: "timerSession", state: "idle", etag: "settled" }
        : {
            name: "timerSession",
            state: "running",
            etag: "running-child",
            task_id: child.id,
            flow_date: timerDate,
            segment_start_time: `${timerDate}T23:55:00Z`,
          };
    else if (url.pathname.startsWith("/api/plus/flowday/api/v1/flows/"))
      response = {
        name: `flows/${url.pathname.split("/").at(-1)}`,
        task_ids:
          url.pathname.endsWith(timerDate) && !settlements.length
            ? [child.id]
            : [],
      };
    else if (url.pathname === "/api/plus/flowday/api/v1/tasks")
      response = { tasks: [] };
    else if (url.pathname === "/api/plus/flowday/api/v1/timeEntries")
      response = { time_entries: [] };
    else if (url.pathname.endsWith("/tasks:sync")) response = {};
    else {
      await route.fulfill({
        status: 500,
        json: {
          error: { message: `Unexpected synthetic request ${url.pathname}` },
        },
      });
      return;
    }
    await route.fulfill({ json: response });
  });
  await page.clock.setFixedTime(new Date(`${today}T00:05:00Z`));
  await page.goto("/#/plan");
  await page
    .getByRole("button", {
      name: "Complete task: Synthetic Plan completion outcome",
      exact: true,
    })
    .click();
  await expect.poll(() => settlements.length).toBe(1);
  expect(genericWrites).toHaveLength(1);
  expect(settlements[0]).toMatchObject({
    task_id: parent.id,
    flow_task_id: child.id,
    flow_date: timerDate,
    task_etag: parent.etag,
    request_id: genericWrites[0]!.requestId,
  });
  const saved = await (
    await request.get(`/api/tasks/v1/tasks/${parent.id}`)
  ).json();
  expect(saved.completed).toBe(true);
  expect(saved.completed_count).toBe(1);
  await expect(page.locator(`[data-outcome-id="${parent.id}"]`)).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "Task completed" }),
  ).toBeVisible();
});
