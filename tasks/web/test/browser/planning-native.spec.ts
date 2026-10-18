import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "block", timezoneId: "America/Los_Angeles" });

test("native Plan, Focus timer and Mail use the owner transport without an extension connection", async ({
  page,
}) => {
  const today = "2026-10-13";
  const tasks: Record<string, unknown>[] = [
    {
      id: "native-outcome",
      title: "Synthetic native weekly outcome",
      area: "work",
      stage: "committed",
      explicit_stage: "committed",
      labels: ["ordinary"],
      planning_flags: [],
      etag: "1",
    },
    {
      id: "native-step",
      title: "Synthetic native next step",
      parent_id: "native-outcome",
      area: "unassigned",
      stage: "none",
      explicit_stage: "none",
      planning_flags: [],
      etag: "1",
    },
  ];
  const plan = {
    timezone: "America/Los_Angeles",
    week_start: "2026-10-12",
    today,
    enabled: true,
    native_planning: true,
    etag: "native-plan",
    inbox_project_id: "mail",
    labels: [],
    available_labels: [],
    mailbox_pending_count: 1,
  };
  let mailPending = true;
  const mailWrites: Record<string, unknown>[] = [];
  let timer: Record<string, unknown> = {
    name: "timerSession",
    state: "idle",
    etag: "0",
  };
  const writes: Record<string, unknown>[] = [];
  const requests: { path: string; authorization: string | null }[] = [];
  await page.route("**/api/plus/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({
      path: url.pathname,
      authorization: request.headers()["authorization"] ?? null,
    });
    let response: unknown;
    if (url.pathname === "/api/plus/v1/plan:read") response = { plan };
    else if (url.pathname === "/api/plus/v1/tasks:setTaskPlan") {
      const body = request.postDataJSON();
      writes.push(body);
      const task = tasks.find((task) => task.id === body.task_id)!;
      if (body.stage !== undefined) {
        task.stage = body.stage;
        task.explicit_stage = body.stage;
      }
      const flags = new Set(task.planning_flags as string[]);
      if (body.quick !== undefined) {
        if (body.quick) flags.add("quick");
        else flags.delete("quick");
      }
      task.planning_flags = [...flags];
      task.etag = String(Number(task.etag) + 1);
      response = { task };
    } else if (url.pathname === "/api/plus/v1/tasks")
      response = { planning_tasks: tasks };
    else if (url.pathname === "/api/plus/flowday/api/v1/tasks")
      response = {
        tasks: [
          {
            name: "tasks/native-step",
            todoist_id: "native-step",
            title: tasks[1]!.title,
            estimated_minutes: 30,
          },
        ],
      };
    else if (url.pathname.startsWith("/api/plus/flowday/api/v1/flows/"))
      response = {
        name: url.pathname.slice("/api/plus/flowday/api/v1/".length),
        task_ids: url.pathname.endsWith(today) ? ["native-step"] : [],
      };
    else if (url.pathname === "/api/plus/flowday/api/v1/timerSession")
      response = timer;
    else if (url.pathname === "/api/plus/flowday/api/v1/timerSession:command") {
      const body = request.postDataJSON();
      expect(body.action).toBe("start");
      expect(body.task_id).toBe("native-step");
      timer = {
        name: "timerSession",
        task_id: body.task_id,
        flow_date: body.flow_date,
        state: "running",
        segment_start_time: "2026-10-13T18:00:00Z",
        etag: "1",
      };
      response = timer;
    } else if (url.pathname === "/api/plus/v1/mailItems")
      response = {
        mail_items: mailPending
          ? [
              {
                id: "native-message",
                title: "Synthetic native mail",
                etag: "mail-1",
                receive_time: "2026-10-13T17:00:00Z",
                brief: "Synthetic native brief",
                has_summary: true,
              },
            ]
          : [],
        categories: [],
        categories_etag: "1",
      };
    else if (url.pathname === "/api/plus/v1/mailItems:fileMailItem") {
      const body = request.postDataJSON();
      mailWrites.push(body);
      expect(body).toMatchObject({
        event_id: "native-message",
        etag: "mail-1",
      });
      expect(body).not.toHaveProperty("task_id");
      mailPending = false;
      response = {
        task: { id: "native-created-mail", title: "Synthetic native mail" },
      };
    } else if (url.pathname === "/api/plus/v1/mailItems:readMailSummary")
      response = { summary: "Synthetic native summary" };
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
  await page.clock.setFixedTime(new Date("2026-10-13T18:00:00Z"));
  await page.goto("/#/plan");
  await expect(
    page.getByText("Synthetic native weekly outcome", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: /api key|token|connection/i }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Planning labels", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Choose a label for this column", { exact: true }),
  ).toHaveCount(0);
  const handle = page.getByRole("button", {
    name: "Move outcome: Synthetic native weekly outcome",
    exact: true,
  });
  const month = page.getByRole("region", { name: "Month", exact: true });
  const source = (await handle.boundingBox())!;
  const target = (await month.boundingBox())!;
  await page.mouse.move(
    source.x + source.width / 2,
    source.y + source.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    source.x + source.width / 2 + 8,
    source.y + source.height / 2,
    { steps: 3 },
  );
  await page.mouse.move(
    target.x + target.width / 2,
    target.y + target.height / 2,
    { steps: 18 },
  );
  await page.mouse.up();
  await expect(
    month.getByText("Synthetic native weekly outcome", { exact: true }),
  ).toBeVisible();
  expect(writes[0]).toMatchObject({
    task_id: "native-outcome",
    stage: "monthly",
  });
  expect(tasks[0]!.labels).toEqual(["ordinary"]);
  await month
    .getByText("Synthetic native weekly outcome", { exact: true })
    .click();
  const details = page.getByRole("dialog");
  await details.getByText("Task options", { exact: true }).click();
  await details
    .getByRole("checkbox", { name: "Quick action", exact: true })
    .click();
  await expect(
    details.getByRole("checkbox", { name: "Quick action", exact: true }),
  ).toBeChecked();
  expect(writes[1]).toMatchObject({ task_id: "native-outcome", quick: true });
  expect(writes[1]).not.toHaveProperty("labels");
  await details.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("link", { name: "Planning settings", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Open Plan", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("combobox")).toHaveCount(0);
  await page.getByRole("link", { name: "Focus", exact: true }).click();
  const step = page.locator('.plus-focus-slot[data-task-id="native-step"]');
  await expect(step).toContainText("Synthetic native next step");
  await expect(step).toContainText("Synthetic native weekly outcome");
  await step
    .getByRole("button", {
      name: "Start: Synthetic native next step",
      exact: true,
    })
    .click();
  await expect(
    step.getByRole("button", {
      name: "Pause: Synthetic native next step",
      exact: true,
    }),
  ).toBeVisible();
  const mailStart = requests.length;
  await page.getByRole("link", { name: "Mail", exact: true }).click();
  await page.getByText("Synthetic native mail", { exact: true }).click();
  await expect(
    page.getByText("Synthetic native summary", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(
    page.getByText("No mail to review", { exact: true }),
  ).toBeVisible();
  expect(mailWrites).toHaveLength(1);
  expect(requests.slice(mailStart).map((request) => request.path)).toEqual([
    "/api/plus/v1/mailItems",
    "/api/plus/v1/mailItems:readMailSummary",
    "/api/plus/v1/mailItems:fileMailItem",
  ]);
  expect(requests.every((request) => request.authorization === null)).toBe(
    true,
  );
  expect(requests.some((request) => request.path.includes("connections"))).toBe(
    false,
  );
});
