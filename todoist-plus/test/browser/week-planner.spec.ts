import {
  expect,
  test,
  type Locator,
  type Page,
  type Worker,
} from "@playwright/test";
import {
  controlWrites,
  dragPlanner,
  launchPlanner,
  plannerDays,
  storedPlanView,
} from "./planner-setup";
async function openWeek(page: Page) {
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await page.getByRole("tab", { name: "Week", exact: true }).click();
}
async function readPlanCount(worker: Worker) {
  return worker.evaluate(
    () =>
      (
        globalThis as unknown as { plannerState: { calls: { path: string }[] } }
      ).plannerState.calls.filter(
        (call) => call.path === "/api/plus/v1/plan:read",
      ).length,
  );
}
async function flowReads(worker: Worker) {
  return worker.evaluate(
    () =>
      (
        globalThis as unknown as {
          plannerState: { calls: { path: string; method: string }[] };
        }
      ).plannerState.calls.filter(
        (call) => call.method === "GET" && call.path.includes("/flows/"),
      ).length,
  );
}
async function cardIds(day: Locator) {
  return day
    .locator(".planning-calendar-step")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-task-id")),
    );
}

test("Review moves an explicit outcome between mapped stages using its identity and etag", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    const quarter = page.getByRole("region", { name: "Quarter", exact: true });
    const month = page.getByRole("region", { name: "Month", exact: true });
    await expect(quarter.locator('[data-outcome-id="quarter"]')).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Week", exact: true })
        .locator('[data-outcome-id="candidate"]'),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Committed", exact: true })
        .locator('[data-outcome-id="parent"]'),
    ).toBeVisible();
    const baseline = await readPlanCount(worker);
    await controlWrites(worker, { hold: true });
    await dragPlanner(
      page,
      quarter.getByRole("button", {
        name: "Move outcome: Synthetic quarter outcome",
      }),
      month,
    );
    // The card moves before Todoist answers and waits, visibly, in its new lane.
    await expect(month.locator('[data-outcome-id="quarter"]')).toBeVisible();
    await expect(quarter.locator('[data-outcome-id="quarter"]')).toHaveCount(0);
    await expect(
      month.locator(".review-draggable[aria-busy=true]"),
    ).toHaveCount(1);
    await expect(
      month.getByRole("button", {
        name: "Move outcome: Synthetic quarter outcome",
      }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", {
        name: "Move outcome: Synthetic week candidate",
      }),
    ).toBeEnabled();
    await controlWrites(worker, { hold: false, release: true });
    await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
    await expect(month.locator('[data-outcome-id="quarter"]')).toBeVisible();
    await expect(page.locator(".plus-page-header .plus-spin")).toHaveCount(0);
    const state = await worker.evaluate(
      () =>
        (
          globalThis as unknown as {
            plannerState: {
              tasks: Record<string, unknown>[];
              calls: { path: string; body: Record<string, unknown> }[];
            };
          }
        ).plannerState,
    );
    const moved = state.tasks.find((task) => task.id === "quarter")!;
    expect(moved.stage).toBe("monthly");
    expect(moved.labels).toEqual(["office", "context", "candiate"]);
    const request = state.calls.find((call) =>
      call.path.endsWith("/tasks:setTaskPlan"),
    )!.body;
    expect(request).toMatchObject({
      task_id: "quarter",
      etag: "quarter-1",
      stage: "monthly",
    });
    expect(request.request_id).toMatch(/^[a-f0-9-]{36}$/u);
    expect(request).not.toHaveProperty("due");
    expect(request).not.toHaveProperty("deadline");
    expect(request).not.toHaveProperty("bet");
    expect(await readPlanCount(worker)).toBe(baseline);
  } finally {
    await context.close();
  }
});

test("a keyboard drop leaves focus on the moved card, which says that it waits", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    const quarter = page.getByRole("region", { name: "Quarter", exact: true });
    const month = page.getByRole("region", { name: "Month", exact: true });
    const handle = quarter.getByRole("button", {
      name: "Move outcome: Synthetic quarter outcome",
    });
    await expect(handle).toBeEnabled();
    const from = (await handle.boundingBox())!;
    const to = (await month.boundingBox())!;
    await controlWrites(worker, { hold: true });
    await handle.focus();
    await page.keyboard.press("Space");
    // Shift+arrow moves the dragged card 50 px at a time.
    for (let step = 0; step * 50 < to.x - from.x; step++)
      await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Space");
    const moved = month.getByRole("button", {
      name: "Move outcome: Synthetic quarter outcome, Updating…",
    });
    await expect(moved).toBeFocused();
    await expect(moved).toBeDisabled();
    await expect(
      month.getByRole("button", {
        name: "Synthetic quarter outcome, P1, Updating…",
      }),
    ).toBeVisible();
    await controlWrites(worker, { hold: false, release: true });
    await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
    await expect(
      month.getByRole("button", {
        name: "Move outcome: Synthetic quarter outcome",
        exact: true,
      }),
    ).toBeFocused();
  } finally {
    await context.close();
  }
});

test("real pointer scheduling uses leaf steps and persists day moves without full task reloads", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await openWeek(page);
    const tray = page.getByRole("region", {
      name: "Next steps: Synthetic weekly outcome",
    });
    await expect(
      tray.getByRole("button", { name: /^Synthetic first step/u }),
    ).toBeVisible();
    await expect(
      page.locator(".planning-commitment-grid [data-outcome-id]"),
    ).toHaveCount(1);
    const baseline = await readPlanCount(worker);
    const flowBaseline = await flowReads(worker);
    const layout = await page
      .locator(".planning-calendar")
      .evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        overflow: element.scrollWidth > element.clientWidth,
        columns: [...element.querySelectorAll(".planning-calendar-day")].map(
          (day) => day.getBoundingClientRect().width,
        ),
      }));
    expect(layout.width).toBeGreaterThan(1200);
    expect(layout.columns).toHaveLength(7);
    expect(layout.columns.every((width) => width >= 130)).toBe(true);
    expect(layout.overflow).toBe(false);
    const thursday = page.locator(
      '.planning-calendar-day[data-date="2026-10-15"]',
    );
    const tuesday = page.locator(
      '.planning-calendar-day[data-date="2026-10-13"]',
    );
    await dragPlanner(
      page,
      tray.getByRole("button", { name: "Drag step: Synthetic second step" }),
      thursday.locator(".planning-day-end"),
    );
    await expect.poll(() => cardIds(thursday)).toEqual(["second"]);
    await expect(page.locator(".plus-page-header .plus-spin")).toHaveCount(0);
    await expect(
      thursday.locator(".planning-calendar-step-meta > span"),
    ).toHaveText("Synthetic weekly outcome");

    await dragPlanner(
      page,
      tuesday.getByRole("button", {
        name: "Drag scheduled step: Synthetic first step",
      }),
      thursday.locator('[data-task-id="second"]'),
    );
    await expect.poll(() => cardIds(thursday)).toEqual(["child", "second"]);
    await expect
      .poll(async () => (await plannerDays(worker))["2026-10-13"])
      .toEqual(["local-one"]);
    await expect(page.locator(".plus-page-header .plus-spin")).toHaveCount(0);
    await dragPlanner(
      page,
      thursday.getByRole("button", {
        name: "Drag scheduled step: Synthetic second step",
      }),
      thursday.locator('[data-task-id="child"]'),
    );
    await expect.poll(() => cardIds(thursday)).toEqual(["second", "child"]);
    await expect(page.locator(".plus-page-header .plus-spin")).toHaveCount(0);
    expect(await readPlanCount(worker)).toBe(baseline);
    // Only the tray drop and the same-day reorder read their one target day; the confirmed
    // queues are shown without reading the whole week again.
    expect((await flowReads(worker)) - flowBaseline).toBe(2);
    // FlowDay task IDs, never titles, survive an idle-stopped worker in session storage.
    expect(
      await worker.evaluate(async () => {
        const storage = (
          globalThis as unknown as {
            chrome: {
              storage: {
                session: {
                  get(key: string): Promise<Record<string, unknown>>;
                };
              };
            };
          }
        ).chrome.storage;
        return (await storage.session.get("knownFlowTasks")).knownFlowTasks;
      }),
    ).toEqual(["child", "second", "local-one"]);
    await page.reload();
    await openWeek(page);
    await expect.poll(() => cardIds(thursday)).toEqual(["second", "child"]);
    const writes = await worker.evaluate(() =>
      (
        globalThis as unknown as {
          plannerState: {
            calls: {
              path: string;
              method: string;
              body: Record<string, unknown>;
            }[];
          };
        }
      ).plannerState.calls.filter((call) => call.method !== "GET"),
    );
    expect(writes.length).toBeGreaterThan(0);
    expect(
      writes.every((call) =>
        call.path.startsWith("/api/plus/flowday/api/v1/flows/"),
      ),
    ).toBe(true);
    expect(
      writes.filter((call) => call.path.endsWith(":rollover")),
    ).toHaveLength(1);
    expect(
      writes.every(
        (call) => !("due" in call.body) && !("deadline" in call.body),
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test("narrow Week remains full width and plans another week without relabelling current commitments", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.setViewportSize({ width: 1100, height: 873 });
    await page.goto("https://app.todoist.com/app/today");
    await openWeek(page);
    await expect(page.locator(".planning-calendar-day:visible")).toHaveCount(3);
    const bounds = await page
      .locator(".planning-calendar")
      .evaluate((element) => ({
        overflow: element.scrollWidth > element.clientWidth,
        documentOverflow: document.documentElement.scrollWidth > innerWidth,
        minColumn: Math.min(
          ...[
            ...element.querySelectorAll<HTMLElement>(".planning-calendar-day"),
          ]
            .filter((day) => getComputedStyle(day).display !== "none")
            .map((day) => day.getBoundingClientRect().width),
        ),
      }));
    expect(bounds.overflow).toBe(false);
    expect(bounds.documentOverflow).toBe(false);
    expect(bounds.minColumn).toBeGreaterThan(140);
    await page
      .getByRole("tab", { name: "Show 2026-10-18", exact: true })
      .click();
    await expect(
      page.locator('.planning-calendar-day[data-date="2026-10-18"]'),
    ).toBeVisible();
    await page.getByRole("button", { name: "Next week", exact: true }).click();
    await page
      .getByRole("tab", { name: "Show 2026-10-25", exact: true })
      .click();
    const sunday = page.locator(
      '.planning-calendar-day[data-date="2026-10-25"]',
    );
    const tray = page.getByRole("region", {
      name: "Next steps: Synthetic weekly outcome",
    });
    await dragPlanner(
      page,
      tray.getByRole("button", { name: "Drag step: Synthetic second step" }),
      sunday.locator(".planning-day-end"),
    );
    await expect.poll(() => cardIds(sunday)).toEqual(["second"]);
    await expect(page.locator(".plus-page-header .plus-spin")).toHaveCount(0);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => cardIds(sunday)).toEqual(["second"]);
    await page.getByRole("button", { name: "This week", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "Show 2026-10-13", exact: true }),
    ).toBeVisible();
    expect((await plannerDays(worker))["2026-10-13"]).toEqual([
      "child",
      "local-one",
    ]);
    await page.setViewportSize({ width: 680, height: 873 });
    await expect(page.locator(".planning-calendar-day:visible")).toHaveCount(1);
    await page
      .getByRole("tab", { name: "Show 2026-10-18", exact: true })
      .click();
    await expect(
      page.locator('.planning-calendar-day[data-date="2026-10-18"]'),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    const writes = await worker.evaluate(() =>
      (
        globalThis as unknown as {
          plannerState: { calls: { path: string; method: string }[] };
        }
      ).plannerState.calls.filter((call) => call.method !== "GET"),
    );
    expect(
      writes.every((call) =>
        call.path.startsWith("/api/plus/flowday/api/v1/flows/"),
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});

test("outcome selection and child details stay accessible while a timed step cannot move", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await openWeek(page);
    const outcome = page
      .locator(".planning-commitment-grid")
      .getByRole("button", { name: /^Synthetic weekly outcome/u });
    await expect(outcome).toBeEnabled();
    await outcome.click();
    await expect(
      page.getByRole("region", {
        name: "Next steps: Synthetic weekly outcome",
      }),
    ).toHaveCount(0);
    await outcome.click();
    const tray = page.getByRole("region", {
      name: "Next steps: Synthetic weekly outcome",
    });
    await tray.getByRole("button", { name: /^Synthetic first step/u }).click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("heading", { name: "Synthetic first step", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await worker.evaluate(() => {
      (
        globalThis as unknown as {
          plannerState: { timer: Record<string, unknown> };
        }
      ).plannerState.timer = {
        name: "timerSession",
        task_id: "child",
        flow_date: "2026-10-13",
        state: "paused",
        etag: "paused-1",
        saved_seconds: 60,
      };
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Resume", exact: true }),
    ).toBeVisible();
    await expect(
      tray.getByRole("button", {
        name: "Drag step: Synthetic first step",
        exact: true,
      }),
    ).toBeDisabled();
    const title = tray.getByRole("button", { name: /^Synthetic first step/u });
    await expect(title).toBeEnabled();
    await title.click();
    await expect(
      page
        .getByRole("dialog")
        .getByRole("heading", { name: "Synthetic first step", exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("drops show at once while saves run in order, and a failed save rolls every pending drop back", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await openWeek(page);
    const tray = page.getByRole("region", {
      name: "Next steps: Synthetic weekly outcome",
    });
    const day = (date: string) =>
      page.locator(`.planning-calendar-day[data-date="${date}"]`);
    const tuesday = day("2026-10-13");
    const thursday = day("2026-10-15");
    const friday = day("2026-10-16");
    await expect(
      tray.getByRole("button", { name: /^Synthetic first step/u }),
    ).toBeVisible();
    await controlWrites(worker, { hold: true });
    await dragPlanner(
      page,
      tray.getByRole("button", { name: "Drag step: Synthetic second step" }),
      thursday.locator(".planning-day-end"),
    );
    await expect.poll(() => cardIds(thursday)).toEqual(["second"]);
    const second = thursday.locator('[data-task-id="second"]');
    await expect(second).toHaveAttribute("aria-busy", "true");
    await expect(
      second.getByRole("button", { name: /^Drag scheduled step/u }),
    ).toBeDisabled();
    // Only the spinner and dimming mark the waiting card; reduced motion stops the spinner.
    await second.hover();
    await expect(second.locator(".planning-step-remove")).toHaveCSS(
      "opacity",
      "0",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(second.locator(".plus-pending-mark")).toHaveCSS(
      "animation-name",
      "none",
    );
    await page.emulateMedia({ reducedMotion: null });
    // The next drag starts while the first save is still held.
    await dragPlanner(
      page,
      tuesday.getByRole("button", {
        name: "Drag scheduled step: Synthetic first step",
      }),
      second,
    );
    await expect.poll(() => cardIds(thursday)).toEqual(["child", "second"]);
    await expect(thursday.locator("[aria-busy=true]")).toHaveCount(2);
    await expect(page.locator(".plus-page-header .plus-spin")).toHaveCount(0);
    expect(await controlWrites(worker, {})).toBe(1);
    await controlWrites(worker, { hold: false, release: true });
    await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
    expect(await cardIds(thursday)).toEqual(["child", "second"]);
    const saved = await plannerDays(worker);
    expect(saved["2026-10-15"]).toEqual(["child", "second"]);
    expect(saved["2026-10-13"]).toEqual(["local-one"]);

    await controlWrites(worker, { hold: true, fail: true });
    await dragPlanner(
      page,
      thursday.getByRole("button", {
        name: "Drag scheduled step: Synthetic second step",
      }),
      friday.locator(".planning-day-end"),
    );
    await expect.poll(() => cardIds(friday)).toEqual(["second"]);
    await dragPlanner(
      page,
      thursday.getByRole("button", {
        name: "Drag scheduled step: Synthetic first step",
      }),
      friday.locator(".planning-day-end"),
    );
    await expect.poll(() => cardIds(friday)).toEqual(["second", "child"]);
    await controlWrites(worker, { hold: false, release: true });
    // The failed save and the one queued behind it both return to the confirmed days.
    await expect(page.getByRole("alert")).toContainText(
      "Synthetic save unavailable",
    );
    await expect.poll(() => cardIds(friday)).toEqual([]);
    expect(await cardIds(thursday)).toEqual(["child", "second"]);
    await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
    expect((await plannerDays(worker))["2026-10-16"] ?? []).toEqual([]);
  } finally {
    await context.close();
  }
});

test("Committed folds to its heading line behind Todoist's quiet chevron, and Next steps stays", async () => {
  const { context } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await openWeek(page);
    const toggle = page.getByRole("button", { name: "Committed", exact: true });
    const opacity = () =>
      toggle.locator("svg").evaluate((icon) => getComputedStyle(icon).opacity);
    const tray = page.getByRole("region", {
      name: "Next steps: Synthetic weekly outcome",
    });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    // Expanded, the chevron shows only while the heading is hovered or the toggle focused.
    expect(await opacity()).toBe("0");
    await toggle.hover();
    expect(await opacity()).toBe("1");
    // The chevron sits in the gutter, as in Todoist's sections: the title keeps the cards' edge.
    const chevron = (await toggle.locator("svg").boundingBox())!;
    const grid = (await page
      .locator(".planning-commitment-grid")
      .boundingBox())!;
    expect(chevron.x + chevron.width).toBeLessThanOrEqual(grid.x);
    const heading = await toggle.boundingBox();
    const expanded = (await tray.boundingBox())!;
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".planning-commitment-grid")).toBeHidden();
    await expect(
      page.getByRole("tablist", { name: "Commitment area" }),
    ).toBeHidden();
    await expect(toggle.locator("xpath=../..")).toHaveText(
      "Committed1 outcome",
    );
    // The heading line itself does not move.
    expect(await toggle.boundingBox()).toEqual(heading);
    // Next steps moves up under the heading, with nothing else changed.
    await expect(tray).toBeVisible();
    expect((await tray.boundingBox())!.y).toBeLessThan(expanded.y);
    await page.mouse.move(5, 5);
    expect(await opacity()).toBe("1");
    await toggle.press("Enter");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".planning-commitment-grid")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("the Week tab, its commitment and the fold survive Mail and Back, and a reload", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await worker.evaluate(() => {
      (
        globalThis as unknown as {
          plannerState: { tasks: Record<string, unknown>[] };
        }
      ).plannerState.tasks.push({
        id: "other-outcome",
        title: "Synthetic second commitment",
        area: "personal",
        stage: "committed",
        etag: "other-outcome-1",
      });
    });
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await openWeek(page);
    await page
      .locator(".planning-commitment-grid")
      .getByRole("button", { name: /^Synthetic second commitment/u })
      .click();
    const toggle = page.getByRole("button", { name: "Committed", exact: true });
    await toggle.click();
    await expect
      .poll(() => storedPlanView(worker))
      .toMatchObject({
        tab: "week",
        commitment: "other-outcome",
        committedFolded: true,
      });
    const restored = async () => {
      await expect(
        page.getByRole("tab", { name: "Week", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      await expect(
        page.getByRole("region", {
          name: "Next steps: Synthetic second commitment",
        }),
      ).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator(".planning-commitment-grid")).toBeHidden();
    };
    await page.getByRole("button", { name: "Mail", exact: true }).click();
    await expect(page).toHaveURL(/todoist-plus=mailbox/u);
    await page.goBack();
    await expect(page).toHaveURL(/todoist-plus=plan$/u);
    await restored();
    await page.reload();
    await restored();
    // Nothing of it reached Todofy or Todoist: the view is the extension's own.
    const writes = await worker.evaluate(() =>
      (
        globalThis as unknown as {
          plannerState: { calls: { method: string }[] };
        }
      ).plannerState.calls.filter((call) => call.method !== "GET"),
    );
    expect(writes).toEqual([]);
  } finally {
    await context.close();
  }
});

test("Add steps adds two sub-tasks one after another, with the input kept open and every keystroke kept", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await openWeek(page);
    const tray = page.getByRole("region", {
      name: "Next steps: Synthetic weekly outcome",
    });
    const button = tray.getByRole("button", {
      name: "Add steps to “Synthetic weekly outcome”",
    });
    // Todoist's own Add task row: muted text after an accent plus, 32px tall, the steps' last cell.
    expect((await button.boundingBox())!.height).toBe(32);
    await button.click();
    const input = tray.getByRole("textbox", { name: "New step" });
    await expect(input).toBeFocused();
    expect((await input.boundingBox())!.height).toBe(32);
    await controlWrites(worker, { hold: true });
    await input.pressSequentially("Synthetic third step");
    await input.press("Enter");
    // Cleared at once and still open; the title waits as a dimmed card.
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    const waiting = tray.locator(".planning-tray-step.is-pending");
    await expect(waiting).toHaveText("Synthetic third step");
    // Typing goes on while the first step saves; Enter waits for it.
    await input.pressSequentially("Synthetic fourth step");
    await expect(input).toHaveAttribute("aria-disabled", "true");
    await input.press("Enter");
    await expect(input).toHaveValue("Synthetic fourth step");
    await controlWrites(worker, { hold: false, release: true });
    // The re-read lists the new sub-task: its card takes the waiting card's place.
    await expect(
      tray.locator(".planning-tray-step:not(.is-pending)", {
        hasText: "Synthetic third step",
      }),
    ).toBeVisible();
    await expect(waiting).toHaveCount(0);
    await expect(input).not.toHaveAttribute("aria-disabled");
    await input.press("Enter");
    await expect(input).toHaveValue("");
    await expect(
      tray.locator(".planning-tray-step:not(.is-pending)", {
        hasText: "Synthetic fourth step",
      }),
    ).toBeVisible();
    await expect(input).toBeFocused();
    const appended = await worker.evaluate(() =>
      (
        globalThis as unknown as {
          plannerState: {
            calls: { path: string; body: Record<string, unknown> }[];
          };
        }
      ).plannerState.calls.filter((call) =>
        call.path.endsWith("/tasks:appendTaskSteps"),
      ),
    );
    expect(appended.map((call) => call.body)).toEqual([
      {
        parent_id: "parent",
        request_id: expect.any(String),
        steps: [{ title: "Synthetic third step" }],
      },
      {
        parent_id: "parent",
        request_id: expect.any(String),
        steps: [{ title: "Synthetic fourth step" }],
      },
    ]);
    expect(appended[0]!.body.request_id).not.toBe(appended[1]!.body.request_id);
    // Esc closes it and goes back to the row.
    await input.press("Escape");
    await expect(input).toHaveCount(0);
    await expect(button).toBeFocused();
  } finally {
    await context.close();
  }
});

test("a quick card under Next steps drags into a day like a step, with one FlowDay queue write", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await worker.evaluate(() => {
      (
        globalThis as unknown as {
          plannerState: { tasks: Record<string, unknown>[] };
        }
      ).plannerState.tasks.push({
        id: "quick-one",
        title: "Synthetic quick errand",
        area: "work",
        stage: "none",
        labels: ["quick"],
        etag: "quick-one-1",
      });
    });
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await openWeek(page);
    const quick = page.getByRole("region", { name: "Quick tasks" });
    const card = quick.locator(".planning-quick-card");
    await expect(card).toHaveText("Synthetic quick errand");
    // A quiet one-line card, under the steps and above the calendar.
    expect((await card.boundingBox())!.height).toBeLessThanOrEqual(28);
    const thursday = page.locator(
      '.planning-calendar-day[data-date="2026-10-15"]',
    );
    await dragPlanner(
      page,
      quick.getByRole("button", {
        name: "Drag quick task: Synthetic quick errand",
      }),
      thursday.locator(".planning-day-end"),
    );
    await expect.poll(() => cardIds(thursday)).toEqual(["quick-one"]);
    await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
    // Planned, it is in the calendar and leaves the Quick line.
    await expect(quick).toHaveCount(0);
    const writes = await worker.evaluate(() =>
      (
        globalThis as unknown as {
          plannerState: {
            calls: {
              path: string;
              method: string;
              body: Record<string, unknown>;
            }[];
          };
        }
      ).plannerState.calls.filter((call) => call.method !== "GET"),
    );
    expect(
      writes
        .filter((call) => !call.path.endsWith("/tasks:sync"))
        .map(({ path, method, body }) => ({ path, method, body })),
    ).toEqual([
      {
        path: "/api/plus/flowday/api/v1/flows/2026-10-15",
        method: "PATCH",
        body: expect.objectContaining({ task_ids: ["quick-one"] }),
      },
    ]);
  } finally {
    await context.close();
  }
});
