import { expect, test, type Page } from "@playwright/test";
import {
  addDays,
  otherDays,
  readFocus,
  readTimer,
  startTimer,
  stubPlanning,
  tasksToday,
  type SeedTask,
} from "./planning-stub";

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("Plan completes an outcome in real D1, which stops its descendant's running timer and marks its queued step done", async ({
  page,
  request,
}) => {
  const parent = { id: crypto.randomUUID(), name: "" };
  parent.name = `tasks/${parent.id}`;
  const child = crypto.randomUUID();
  // The child is queued on Tasks' today and its timer runs there.
  const today = await tasksToday();
  await stubPlanning(page, {
    tasks: [
      {
        id: parent.id,
        title: "Synthetic Plan completion outcome",
        stage: "committed",
        area: "work",
      },
      {
        id: child,
        title: "Synthetic running descendant",
        kind: "step",
        parent_id: parent.id,
      },
    ],
    queues: { [today]: [child] },
  });
  await startTimer(child);
  const { etag } = await (
    await request.get(`/api/tasks/v1/tasks/${parent.id}`)
  ).json();
  const genericWrites: { requestId: string; etag: string; focusDay: string }[] =
    [];
  let reads = 0;
  page.on("request", (event) => {
    const url = new URL(event.url());
    if (url.pathname === `/api/tasks/v1/${parent.name}`) reads++;
    if (url.pathname !== `/api/tasks/v1/${parent.name}:complete`) return;
    const body = event.postDataJSON() || {};
    genericWrites.push({
      requestId: body.request_id || url.searchParams.get("request_id"),
      etag: body.etag,
      focusDay: body.focus_day,
    });
  });
  await page.goto("/#/plan");
  // The running session shows in the timer bar.
  await expect(
    page.getByRole("complementary", { name: "Focus" }),
  ).toContainText("Synthetic running descendant");
  await page
    .getByRole("button", {
      name: "Complete task: Synthetic Plan completion outcome",
      exact: true,
    })
    .click();
  await expect.poll(() => genericWrites.length).toBe(1);
  // One Tasks write, on Focus's day; the session settles on its own day in it. It goes under the
  // etag Plan holds, with no read of the task first.
  expect(genericWrites[0]).toEqual({
    requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    etag,
    focusDay: today,
  });
  expect(reads).toBe(0);
  const saved = await (
    await request.get(`/api/tasks/v1/tasks/${parent.id}`)
  ).json();
  expect(saved.completed).toBe(true);
  expect(saved.completed_count).toBe(1);
  expect((await readTimer()).state).toBe("idle");
  const [day] = (await readFocus(today, today)).days as {
    task_ids?: string[];
    done_task_ids?: string[];
  }[];
  expect([day?.task_ids ?? [], day?.done_task_ids]).toEqual([[], [child]]);
  await expect(page.locator(`[data-outcome-id="${parent.id}"]`)).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "Task completed" }),
  ).toBeVisible();
});

test.describe("Plan's cards", () => {
  test.use({ serviceWorkers: "block", timezoneId: "America/Los_Angeles" });
  // Tasks' today, by the dev server's clock: the page's clock is set to it.
  let today: string;
  test.beforeAll(async () => {
    today = await tasksToday();
  });
  const outcome = (
    id: string,
    title: string,
    fields: Partial<SeedTask> = {},
  ): SeedTask => ({
    id,
    title,
    area: "work",
    stage: "committed",
    ...fields,
  });
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
      tasks: [
        outcome("launch", "Synthetic launch"),
        outcome("audit", "Synthetic audit"),
        outcome("venue", "Synthetic venue booking", { area: "personal" }),
        outcome("report", "Synthetic report"),
        outcome("quarter", "Synthetic quarter outcome", { stage: "quarterly" }),
        outcome("month", "Synthetic month outcome", { stage: "monthly" }),
        outcome("week", "Synthetic week candidate", { stage: "weekly" }),
        // Inside its start window: Tasks says it must start.
        outcome("claim", "Submit the expense claim", {
          stage: "none",
          deadline: addDays(today, 1),
          lead_days: 3,
        }),
        outcome("waiting", "Synthetic waiting task", {
          stage: "none",
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
        // Parked, Quarter, Month and Week keep one row of columns.
        const columns = await page
          .locator('.review-lane:not([data-lane="committed"])')
          .evaluateAll((nodes) =>
            nodes.map((node) => node.getBoundingClientRect().toJSON()),
          );
        expect(columns).toHaveLength(4);
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
      [...state.requests, ...state.tasksRequests].filter(
        (request) => request.method !== "GET",
      ),
    ).toEqual([]);
  });

  test("Plan completes a tray Step, a scheduled Step and an outcome in Tasks, settling the queued Step on its day", async ({
    page,
    request,
  }) => {
    const parent = {
      id: crypto.randomUUID(),
      title: "Synthetic weekly outcome",
    };
    const first = { id: crypto.randomUUID(), title: "Synthetic first step" };
    const second = { id: crypto.randomUUID(), title: "Synthetic second step" };
    const step = (task: { id: string; title: string }): SeedTask => ({
      ...task,
      kind: "step",
      parent_id: parent.id,
    });
    // The first step is scheduled on another day of this week than Tasks' today.
    const [scheduled] = otherDays(today) as [string];
    await stubPlanning(page, {
      tasks: [outcome(parent.id, parent.title), step(first), step(second)],
      queues: { [scheduled]: [first.id] },
    });
    const completions: { id: string; requestId: string; focusDay: string }[] =
      [];
    page.on("request", (event) => {
      const match = /^\/api\/tasks\/v1\/tasks\/([^/:]+):complete$/u.exec(
        new URL(event.url()).pathname,
      );
      if (match)
        completions.push({
          id: match[1]!,
          requestId: event.postDataJSON()?.request_id,
          focusDay: event.postDataJSON()?.focus_day,
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
    const day = page.locator(
      `.planning-calendar-day[data-date="${scheduled}"]`,
    );
    await day
      .getByRole("button", {
        name: "Complete task: Synthetic first step",
        exact: true,
      })
      .click();
    // The scheduled Step stays in its day, done.
    await expect(
      day.getByRole("button", {
        name: "Completed: Synthetic first step",
        exact: true,
      }),
    ).toBeVisible();
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
    // A scheduled Step completes on its own day; the others on Focus's, Tasks' today.
    expect(completions.map((write) => write.focusDay)).toEqual([
      today,
      scheduled,
      today,
    ]);
    const [queue] = (await readFocus(scheduled, scheduled)).days as {
      task_ids?: string[];
      done_task_ids?: string[];
    }[];
    expect([queue?.task_ids ?? [], queue?.done_task_ids]).toEqual([
      [],
      [first.id],
    ]);
    for (const task of [parent, first, second]) {
      const saved = await request.get(`/api/tasks/v1/tasks/${task.id}`);
      expect((await saved.json()).completed).toBe(true);
    }
  });

  test("a ticked calendar Step stays in its day, done and out of the day's total, and Focus is unchanged", async ({
    page,
  }) => {
    const parent = {
      id: crypto.randomUUID(),
      title: "Synthetic done-step outcome",
    };
    const ticked = { id: crypto.randomUUID(), title: "Synthetic ticked step" };
    const open = { id: crypto.randomUUID(), title: "Synthetic open step" };
    const step = (
      task: { id: string; title: string },
      minutes: number,
    ): SeedTask => ({
      ...task,
      kind: "step",
      parent_id: parent.id,
      duration_minutes: minutes,
    });
    await stubPlanning(page, {
      tasks: [
        outcome(parent.id, parent.title),
        step(ticked, 30),
        step(open, 45),
      ],
      queues: { [today]: [ticked.id, open.id] },
    });
    // Wide enough for all seven days side by side.
    await page.setViewportSize({ width: 1800, height: 1000 });
    await openPlan(page);
    await page.getByRole("tab", { name: "Week", exact: true }).click();
    const day = page.locator(`.planning-calendar-day[data-date="${today}"]`);
    const total = day.locator(".planning-day-heading small");
    const card = (id: string) =>
      day.locator(`.planning-calendar-step[data-task-id="${id}"]`);
    await expect(total).toHaveText("1h 15m");
    await day
      .getByRole("button", {
        name: `Complete task: ${ticked.title}`,
        exact: true,
      })
      .click();
    // After Tasks' re-read it stays in the day, after the open step, in the done style.
    const done = day.getByRole("button", {
      name: `Completed: ${ticked.title}`,
      exact: true,
    });
    await expect(done).toBeVisible();
    await expect(card(ticked.id)).toHaveClass(/\bis-done\b/u);
    await expect(done).toHaveCSS("text-decoration-line", "line-through");
    await expect(
      card(ticked.id).locator(".plus-checkbox.is-done"),
    ).toBeVisible();
    // Focus's done style, compared with Focus's own done row below.
    const doneStyle = {
      title: await done.evaluate((title) => getComputedStyle(title).color),
      check: await card(ticked.id)
        .locator(".plus-checkbox.is-done")
        .evaluate((check) => getComputedStyle(check).backgroundColor),
      opacity: await card(ticked.id)
        .locator(".planning-calendar-step-top")
        .evaluate((top) => getComputedStyle(top).opacity),
    };
    expect(doneStyle.title).not.toBe(
      await card(open.id)
        .locator(".planning-step-title")
        .evaluate((title) => getComputedStyle(title).color),
    );
    expect(doneStyle.opacity).toBe("0.72");
    expect(
      await day
        .locator(".planning-calendar-step")
        .evaluateAll((cards) =>
          cards.map((item) => (item as HTMLElement).dataset.taskId),
        ),
    ).toEqual([open.id, ticked.id]);
    // The total covers the open steps; the done one cannot be dragged, removed or ticked again.
    await expect(total).toHaveText("45m");
    await expect(card(ticked.id).getByRole("button")).toHaveCount(1);
    await expect(
      day.getByRole("button", { name: `Drag scheduled step: ${open.title}` }),
    ).toHaveCount(1);
    const [queue] = (await readFocus(today, today)).days as {
      task_ids?: string[];
      done_task_ids?: string[];
    }[];
    expect([queue?.task_ids, queue?.done_task_ids]).toEqual([
      [open.id],
      [ticked.id],
    ]);
    // Focus is as it was: the open step in the queue, the done one only under Completed.
    await page.goto("/#/focus");
    const focusCard = (id: string) =>
      page.locator(`.plus-focus-slot[data-task-id="${id}"]`);
    await expect(focusCard(open.id)).toBeVisible();
    await expect(focusCard(ticked.id)).toHaveCount(0);
    const completed = page.getByRole("checkbox", { name: "Completed" });
    await expect(completed).not.toBeChecked();
    await completed.check();
    const focusDone = page.locator(
      `.plus-focus-done [data-task-id="${ticked.id}"]`,
    );
    await expect(focusDone).toBeVisible();
    expect({
      title: await focusDone
        .locator(".plus-focus-title")
        .evaluate((title) => getComputedStyle(title).color),
      check: await focusDone
        .locator(".plus-checkbox.is-done")
        .evaluate((check) => getComputedStyle(check).backgroundColor),
      opacity: await focusDone
        .locator(".plus-focus-block-top")
        .evaluate((top) => getComputedStyle(top).opacity),
    }).toEqual(doneStyle);
  });

  test("a done calendar Step's title opens Tasks' dialog, where reopening puts it back among its day's open steps", async ({
    page,
  }) => {
    const parent = {
      id: crypto.randomUUID(),
      title: "Synthetic reopened-step outcome",
    };
    const ticked = {
      id: crypto.randomUUID(),
      title: "Synthetic reopened step",
    };
    const open = { id: crypto.randomUUID(), title: "Synthetic waiting step" };
    const step = (
      task: { id: string; title: string },
      minutes: number,
    ): SeedTask => ({
      ...task,
      kind: "step",
      parent_id: parent.id,
      duration_minutes: minutes,
    });
    await stubPlanning(page, {
      tasks: [
        outcome(parent.id, parent.title),
        step(ticked, 30),
        step(open, 45),
      ],
      queues: { [today]: [ticked.id, open.id] },
    });
    await page.setViewportSize({ width: 1800, height: 1000 });
    await openPlan(page);
    await page.getByRole("tab", { name: "Week", exact: true }).click();
    const day = page.locator(`.planning-calendar-day[data-date="${today}"]`);
    const total = day.locator(".planning-day-heading small");
    await day
      .getByRole("button", {
        name: `Complete task: ${ticked.title}`,
        exact: true,
      })
      .click();
    const done = day.getByRole("button", {
      name: `Completed: ${ticked.title}`,
      exact: true,
    });
    await expect(total).toHaveText("45m");
    // From the keyboard: the title is the done card's one control.
    await done.focus();
    await page.keyboard.press("Enter");
    const dialog = page.locator("dialog.task-dialog");
    await dialog
      .getByRole("button", { name: "Reopen task", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "Task reopened" }),
    ).toBeVisible();
    // Tasks reopened the day's mark: the step is open again, in its first place, and counted.
    await expect(done).toHaveCount(0);
    await expect(
      day.getByRole("button", {
        name: `Complete task: ${ticked.title}`,
        exact: true,
      }),
    ).toBeVisible();
    expect(
      await day
        .locator(".planning-calendar-step")
        .evaluateAll((cards) =>
          cards.map((item) => [
            (item as HTMLElement).dataset.taskId,
            item.classList.contains("is-done"),
          ]),
        ),
    ).toEqual([
      [ticked.id, false],
      [open.id, false],
    ]);
    await expect(total).toHaveText("1h 15m");
  });

  test("a failed Plan completion keeps the card and retries with the same request ID", async ({
    page,
    request,
  }) => {
    const task = {
      id: crypto.randomUUID(),
      title: "Synthetic quarter outcome",
    };
    await stubPlanning(page, {
      tasks: [outcome(task.id, task.title, { stage: "quarterly" })],
    });
    const attempts: { requestId: string; focusDay: string }[] = [];
    await page.route(`**/api/tasks/v1/tasks/${task.id}:complete`, (route) => {
      const body = route.request().postDataJSON();
      attempts.push({ requestId: body?.request_id, focusDay: body?.focus_day });
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
    // The retry resends the same request: its ID and its Focus day.
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(attempts[0]!.requestId).toMatch(/^[0-9a-f-]{36}$/u);
    const saved = await request.get(`/api/tasks/v1/tasks/${task.id}`);
    expect((await saved.json()).completed).toBe(true);
  });
});
