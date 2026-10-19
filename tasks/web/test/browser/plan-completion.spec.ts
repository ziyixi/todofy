import { expect, test, type Page } from "@playwright/test";
import { createTask, stubPlanning, type Json } from "./planning-stub";

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

test.describe("Plan's cards", () => {
  test.use({ serviceWorkers: "block", timezoneId: "America/Los_Angeles" });
  const today = "2026-10-13";
  const outcome = (id: string, title: string, fields: Json = {}): Json => ({
    id,
    kind: "task",
    title,
    area: "work",
    stage: "committed",
    explicit_stage: "committed",
    planning_flags: [],
    etag: "1",
    ...fields,
  });
  const candidate = (stage: string) => ({ stage, explicit_stage: stage });
  async function openPlan(page: Page) {
    await page.clock.setFixedTime(new Date(`${today}T18:00:00Z`));
    await page.goto("/#/plan");
    await expect(
      page.getByRole("region", { name: "Weekly goals" }),
    ).toBeVisible();
  }

  test("Committed spans the board below the candidate columns and lays its cards out side by side", async ({
    page,
  }) => {
    const state = await stubPlanning(page, {
      today,
      tasks: [
        outcome("launch", "Synthetic launch"),
        outcome("audit", "Synthetic audit"),
        outcome("venue", "Synthetic venue booking", { area: "personal" }),
        outcome("report", "Synthetic report"),
        outcome("quarter", "Synthetic quarter outcome", candidate("quarterly")),
        outcome("month", "Synthetic month outcome", candidate("monthly")),
        outcome("week", "Synthetic week candidate", candidate("weekly")),
        outcome("claim", "Submit the expense claim", {
          ...candidate("none"),
          deadline: "2026-10-14",
          lead_days: 3,
          must_start: true,
        }),
        outcome("waiting", "Synthetic waiting task", {
          ...candidate("none"),
          planning_flags: ["waiting"],
        }),
      ],
    });
    await openPlan(page);
    const committed = page.getByRole("region", {
      name: "Committed",
      exact: true,
    });
    for (const width of [1440, 1024, 680]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(committed.locator(".planning-outcome-card")).toHaveCount(4);
      const board = (await page.locator(".review-lanes").boundingBox())!;
      const bounds = (await committed.boundingBox())!;
      if (width === 1440) {
        // Start now, Waiting, Parked, Quarter, Month and Week keep one row of columns.
        const columns = await page
          .locator('.review-lane:not([data-lane="committed"])')
          .evaluateAll((nodes) =>
            nodes.map((node) => node.getBoundingClientRect().toJSON()),
          );
        expect(columns).toHaveLength(6);
        for (const [index, column] of columns.entries()) {
          expect(column.y).toBeCloseTo(columns[0]!.y, 0);
          expect(column.width).toBeCloseTo(columns[0]!.width, 0);
          if (index) expect(column.x).toBeGreaterThan(columns[index - 1]!.x);
        }
      }
      expect(bounds.x).toBeCloseTo(board.x, 0);
      expect(bounds.width).toBeCloseTo(board.width, 0);
      for (const lane of ["Quarter", "Month", "Week"]) {
        const above = (await page
          .getByRole("region", { name: lane, exact: true })
          .boundingBox())!;
        expect(bounds.y).toBeGreaterThanOrEqual(above.y + above.height);
      }
      const cards = await committed.locator(".planning-outcome-card").all();
      const first = (await cards[0]!.boundingBox())!;
      const second = (await cards[1]!.boundingBox())!;
      if (board.width > 500) {
        expect(second.y).toBeCloseTo(first.y, 0);
        expect(second.x).toBeGreaterThan(first.x);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
      ).toBe(false);
    }
    // The completion checkbox comes between the card and its Start action, and showing Start on
    // hover does not narrow the title.
    await page.setViewportSize({ width: 1440, height: 900 });
    const claim = page.locator(".review-draggable", {
      has: page.locator('[data-outcome-id="claim"]'),
    });
    const titleWidth = () =>
      claim
        .locator(".planning-outcome-title")
        .evaluate((element) => element.getBoundingClientRect().width);
    const before = await titleWidth();
    await claim.hover();
    expect(await titleWidth()).toBeCloseTo(before, 0);
    await page.mouse.move(0, 0);
    await claim.locator(".planning-outcome-card").focus();
    await page.keyboard.press("Tab");
    await expect(
      claim.getByRole("button", {
        name: "Complete task: Submit the expense claim",
        exact: true,
      }),
    ).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      claim.getByRole("button", {
        name: "Start: Submit the expense claim",
        exact: true,
      }),
    ).toBeFocused();
    expect(
      state.requests.filter((request) => request.method !== "GET"),
    ).toEqual([]);
  });

  test("Plan completes a tray Step, a scheduled Step and an outcome in Tasks, settling the queued Step on its day", async ({
    page,
    request,
  }) => {
    const parent = await createTask(request, {
      title: "Synthetic weekly outcome",
    });
    // One at a time: each CSRF read replaces the previous token.
    const first = await createTask(request, {
      title: "Synthetic first step",
      kind: "step",
      parent_id: parent.id,
    });
    const second = await createTask(request, {
      title: "Synthetic second step",
      kind: "step",
      parent_id: parent.id,
    });
    const step = (task: { id: string; title: string }): Json => ({
      ...outcome(task.id, task.title, candidate("none")),
      kind: "step",
      parent_id: parent.id,
      area: "unassigned",
    });
    const state = await stubPlanning(
      page,
      {
        today,
        tasks: [outcome(parent.id, parent.title), step(first), step(second)],
        flowTasks: [first, second].map((task) => ({
          name: `tasks/${task.id}`,
          todoist_id: task.id,
          title: task.title,
          estimated_minutes: 30,
        })),
        days: { [today]: [first.id] },
      },
      request,
    );
    const completions: { id: string; requestId: string }[] = [];
    page.on("request", (event) => {
      const match = /^\/api\/tasks\/v1\/tasks\/([^/:]+):complete$/u.exec(
        new URL(event.url()).pathname,
      );
      if (match)
        completions.push({
          id: match[1]!,
          requestId: event.postDataJSON()?.request_id,
        });
    });
    // Wide enough for all seven days side by side.
    await page.setViewportSize({ width: 1800, height: 1000 });
    await openPlan(page);
    await page.getByRole("tab", { name: "Week", exact: true }).click();
    const tray = page.getByRole("region", {
      name: "Next steps: Synthetic weekly outcome",
    });
    await tray
      .getByRole("button", {
        name: "Complete task: Synthetic second step",
        exact: true,
      })
      .click();
    await expect(tray.locator(`[data-task-id="${second.id}"]`)).toHaveCount(0);
    const day = page.locator(`.planning-calendar-day[data-date="${today}"]`);
    await day
      .getByRole("button", {
        name: "Complete task: Synthetic first step",
        exact: true,
      })
      .click();
    await expect(day.locator(`[data-task-id="${first.id}"]`)).toHaveCount(0);
    await page.getByRole("tab", { name: "Review", exact: true }).click();
    const committed = page.getByRole("region", {
      name: "Committed",
      exact: true,
    });
    await committed
      .getByRole("button", {
        name: "Complete task: Synthetic weekly outcome",
        exact: true,
      })
      .click();
    await expect(
      committed.locator(`[data-outcome-id="${parent.id}"]`),
    ).toHaveCount(0);
    expect(completions.map((write) => write.id)).toEqual([
      second.id,
      first.id,
      parent.id,
    ]);
    expect(new Set(completions.map((write) => write.requestId)).size).toBe(3);
    for (const write of completions)
      expect(write.requestId).toMatch(/^[a-f0-9-]{36}$/u);
    // Only the Step in its day's queue settles FlowDay: on that day, under its completion's request ID.
    expect(
      state.requests
        .filter((call) => call.path === "/api/plus/v1/tasks:completeTask")
        .map((call) => call.body),
    ).toEqual([
      expect.objectContaining({
        task_id: first.id,
        flow_date: today,
        request_id: completions[1]!.requestId,
      }),
    ]);
    expect(state.days[today]).toEqual([]);
    for (const task of [parent, first, second]) {
      const saved = await request.get(`/api/tasks/v1/tasks/${task.id}`);
      expect((await saved.json()).completed).toBe(true);
    }
  });

  test("a failed Plan completion keeps the card and retries with the same request ID", async ({
    page,
    request,
  }) => {
    const task = await createTask(request, {
      title: "Synthetic quarter outcome",
    });
    await stubPlanning(
      page,
      { today, tasks: [outcome(task.id, task.title, candidate("quarterly"))] },
      request,
    );
    const attempts: string[] = [];
    await page.route(`**/api/tasks/v1/tasks/${task.id}:complete`, (route) => {
      attempts.push(route.request().postDataJSON()?.request_id);
      return attempts.length === 1
        ? route.fulfill({
            status: 503,
            json: {
              error: {
                code: 503,
                status: "UNAVAILABLE",
                message: "Synthetic save unavailable",
              },
            },
          })
        : route.continue();
    });
    await openPlan(page);
    const quarter = page.getByRole("region", { name: "Quarter", exact: true });
    const complete = quarter.getByRole("button", {
      name: "Complete task: Synthetic quarter outcome",
      exact: true,
    });
    await complete.click();
    await expect(
      page.getByText("Synthetic save unavailable", { exact: true }).first(),
    ).toBeVisible();
    await expect(
      quarter.locator(`[data-outcome-id="${task.id}"]`),
    ).toBeVisible();
    await complete.click();
    await expect(quarter.locator(`[data-outcome-id="${task.id}"]`)).toHaveCount(
      0,
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toBe(attempts[0]);
    const saved = await request.get(`/api/tasks/v1/tasks/${task.id}`);
    expect((await saved.json()).completed).toBe(true);
  });
});
