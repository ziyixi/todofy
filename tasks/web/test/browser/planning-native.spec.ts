import { expect, test } from "@playwright/test";
import { flowdayTaskWrites, stubPlanning } from "./planning-stub";

test.use({ serviceWorkers: "block", timezoneId: "America/Los_Angeles" });

test("native Plan, Focus timer and Mail use the owner transport without an extension connection", async ({
  page,
}) => {
  const today = "2026-10-13";
  const tasks: Record<string, unknown>[] = [
    {
      id: "native-outcome",
      kind: "task",
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
      kind: "step",
      title: "Synthetic native next step",
      parent_id: "native-outcome",
      area: "unassigned",
      stage: "none",
      explicit_stage: "none",
      planning_flags: [],
      etag: "1",
    },
  ];
  const state = await stubPlanning(page, {
    today,
    tasks,
    flowTasks: [
      {
        name: "tasks/native-step",
        todoist_id: "native-step",
        title: tasks[1]!.title,
        estimated_minutes: 30,
      },
    ],
    days: { [today]: ["native-step"] },
    mail: [
      {
        id: "native-message",
        title: "Synthetic native mail",
        etag: "mail-1",
        receive_time: "2026-10-13T17:00:00Z",
        brief: "Synthetic native brief",
        has_summary: true,
      },
    ],
    summaries: { "native-message": "Synthetic native summary" },
  });
  const writes = () =>
    state.requests
      .filter((request) => request.path === "/api/plus/v1/tasks:setTaskPlan")
      .map((request) => request.body);
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
  await expect.poll(() => writes()[0]).toMatchObject({
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
  await expect
    .poll(() => writes()[1])
    .toMatchObject({ task_id: "native-outcome", quick: true });
  expect(writes()[1]).not.toHaveProperty("labels");
  await details.getByRole("button", { name: "Close", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Planning settings", exact: true }),
  ).toHaveCount(0);
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
  const command = state.requests.find((request) =>
    request.path.endsWith("/timerSession:command"),
  );
  expect(command?.body).toMatchObject({
    action: "start",
    task_id: "native-step",
  });
  await step
    .getByRole("button", {
      name: "Pause: Synthetic native next step",
      exact: true,
    })
    .click();
  await expect(
    step.getByRole("button", {
      name: "Resume: Synthetic native next step",
      exact: true,
    }),
  ).toBeVisible();
  await step
    .getByRole("button", {
      name: "Complete task: Synthetic native next step",
      exact: true,
    })
    .click();
  // The completion's re-read no longer lists the task.
  await expect(
    step.getByRole("button", { name: /^Complete task:/u }),
  ).toHaveCount(0);
  await expect(page.locator(".plus-page-header .plus-spin")).toHaveCount(0);
  expect(
    state.requests.filter(
      (request) => request.path === "/api/plus/v1/tasks:completeTask",
    ),
  ).toHaveLength(1);
  // Focus writes the timer and completes through Tasks; FlowDay's own task API stays untouched.
  expect(flowdayTaskWrites(state)).toEqual([]);
  const mailStart = state.requests.length;
  await page.getByRole("link", { name: "Mail", exact: true }).click();
  await page.getByText("Synthetic native mail", { exact: true }).click();
  await expect(
    page.getByText("Synthetic native summary", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(
    page.getByText("No mail to review", { exact: true }),
  ).toBeVisible();
  const conversions = state.requests.filter(
    (request) => request.path === "/api/plus/v1/mailItems:convertMailItem",
  );
  expect(conversions).toHaveLength(1);
  expect(conversions[0]!.body).toMatchObject({
    event_id: "native-message",
    etag: "mail-1",
  });
  expect(conversions[0]!.body).not.toHaveProperty("task_id");
  expect(
    state.requests.slice(mailStart).map((request) => request.path),
  ).toEqual([
    "/api/plus/v1/mailItems",
    "/api/plus/v1/mailItems:readMailSummary",
    "/api/plus/v1/mailItems:convertMailItem",
  ]);
  expect(
    state.requests.every((request) => request.authorization === null),
  ).toBe(true);
  expect(
    state.requests.some((request) => request.path.includes("connections")),
  ).toBe(false);
});
