import { expect, test } from "@playwright/test";
import { dragPlanner, launchPlanner, plannerDays } from "./planner-setup";

test("steps arranged in Plan appear directly in today's execution-only Focus", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await page.getByRole("tab", { name: "Week", exact: true }).click();
    const today = page.locator(
      '.planning-calendar-day[data-date="2026-10-13"]',
    );
    await dragPlanner(
      page,
      page
        .getByRole("region", { name: "Steps: Synthetic weekly outcome" })
        .getByRole("button", {
          name: "Drag step: Synthetic second step",
        }),
      today.locator(".planning-day-end"),
    );
    await expect
      .poll(async () => (await plannerDays(worker))["2026-10-13"])
      .toEqual(["child", "local-one", "second"]);
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    const stack = page.getByRole("list", { name: "Today's steps" });
    await expect
      .poll(() =>
        stack
          .locator(".plus-focus-slot")
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-task-id")),
          ),
      )
      .toEqual(["child", "local-one", "second"]);
    await expect(stack.getByLabel("Parent task")).toHaveCount(2);
    await expect(stack.getByLabel("Parent task").first()).toHaveText(
      "Synthetic weekly outcome",
    );
    await expect(
      stack.getByText("Synthetic local note", { exact: true }),
    ).toBeVisible();
    await expect(stack.getByText("30m", { exact: true })).toBeVisible();
    await expect(stack.getByText("1h", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /Choose tasks|Drag step|Remove from day|Move up|Move down/,
      }),
    ).toHaveCount(0);
    await expect(stack.getByRole("combobox")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Start: Synthetic first step" }),
    ).toBeEnabled();
    const fontSizes = await stack
      .locator('[data-task-id="child"]')
      .evaluate((slot) => ({
        title: getComputedStyle(slot.querySelector(".plus-focus-title")!)
          .fontSize,
        parent: getComputedStyle(slot.querySelector(".plus-focus-parent")!)
          .fontSize,
        estimate: getComputedStyle(slot.querySelector(".plus-focus-estimate")!)
          .fontSize,
      }));
    expect(fontSizes).toEqual({
      title: "14px",
      parent: "12px",
      estimate: "12px",
    });
    await page
      .getByRole("button", { name: "Adjust plan", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Plan", exact: true }),
    ).toBeVisible();
    expect((await plannerDays(worker))["2026-10-13"]).toEqual([
      "child",
      "local-one",
      "second",
    ]);
  } finally {
    await context.close();
  }
});

test("confirmed FlowDay timer advances across views, pauses, resumes and stops without completing the task", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await worker.evaluate(() => {
      const state = (
        globalThis as unknown as {
          plannerState: {
            timer: Record<string, unknown>;
            calls: {
              path: string;
              method: string;
              body: Record<string, unknown>;
            }[];
          };
        }
      ).plannerState;
      const existingFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const path = new URL(String(input)).pathname;
        if (!path.endsWith("/timerSession:command"))
          return existingFetch(input, init);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        state.calls.push({ path, method: init?.method ?? "GET", body });
        if (body.etag !== state.timer.etag)
          throw new Error("Synthetic timer etag conflict");
        const action = body.action;
        const saved =
          Number(state.timer.saved_seconds ?? 0) +
          (state.timer.state === "running"
            ? Math.max(
                0,
                Math.floor(
                  (Date.now() -
                    Date.parse(String(state.timer.segment_start_time))) /
                    1000,
                ),
              )
            : 0);
        const etag = String(Number(state.timer.etag) + 1);
        if (action === "stop")
          state.timer = { name: "timerSession", state: "idle", etag };
        else if (["start", "pause", "resume"].includes(String(action)))
          state.timer = {
            name: "timerSession",
            task_id: body.task_id,
            flow_date: body.flow_date,
            state: action === "pause" ? "paused" : "running",
            etag,
            saved_seconds: action === "start" ? 0 : saved,
            ...(action !== "pause"
              ? { segment_start_time: new Date().toISOString() }
              : {}),
          };
        else throw new Error(`Unexpected synthetic timer action ${action}`);
        return Response.json(state.timer);
      };
    });
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    const task = page.locator('.plus-focus-slot[data-task-id="child"]');
    await task
      .getByRole("button", { name: "Start: Synthetic first step" })
      .click();
    await expect(
      task.getByRole("button", { name: "Pause: Synthetic first step" }),
    ).toHaveText("Pause");
    const elapsed = task.getByLabel("Time focused");
    await expect(elapsed).toHaveText(/^\d{2}:\d{2}$/);
    const started = await elapsed.textContent();
    await expect
      .poll(async () => await elapsed.textContent())
      .not.toBe(started);
    await page
      .getByRole("button", { name: "Adjust plan", exact: true })
      .click();
    const globalElapsed = page.locator(".plus-timer-bar output");
    const before = await globalElapsed.textContent();
    await expect
      .poll(async () => await globalElapsed.textContent())
      .not.toBe(before);
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    await task
      .getByRole("button", { name: "Pause: Synthetic first step" })
      .click();
    await expect(
      task.getByRole("button", { name: "Resume: Synthetic first step" }),
    ).toHaveText("Resume");
    const paused = await elapsed.textContent();
    await page.waitForTimeout(1200);
    await expect(elapsed).toHaveText(paused!);
    await task
      .getByRole("button", { name: "Resume: Synthetic first step" })
      .click();
    await expect.poll(async () => await elapsed.textContent()).not.toBe(paused);
    await task
      .getByRole("button", { name: "Stop session: Synthetic first step" })
      .click();
    await expect(
      task.getByRole("button", { name: "Start: Synthetic first step" }),
    ).toHaveText("Start");
    await expect(task.getByLabel("Time focused")).toHaveCount(0);
    await expect(page.locator(".plus-timer-bar")).toHaveCount(0);
    expect((await plannerDays(worker))["2026-10-13"]).toEqual([
      "child",
      "local-one",
    ]);
    const calls = await worker.evaluate(
      () =>
        (
          globalThis as unknown as {
            plannerState: {
              calls: { path: string; body: Record<string, unknown> }[];
            };
          }
        ).plannerState.calls,
    );
    expect(
      calls
        .filter((call) => call.path.endsWith("/timerSession:command"))
        .map((call) => call.body.action),
    ).toEqual(["start", "pause", "resume", "stop"]);
    expect(calls.some((call) => call.path.includes(":complete"))).toBe(false);
  } finally {
    await context.close();
  }
});

test("today's Focus preserves an older timer without treating the same task as today's active session, and its bar stays centred", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const before = await worker.evaluate(() => {
      const state = (
        globalThis as unknown as {
          plannerState: {
            days: Record<string, string[]>;
            timer: Record<string, unknown>;
          };
        }
      ).plannerState;
      state.days["2026-10-12"] = ["child"];
      state.timer = {
        name: "timerSession",
        task_id: "child",
        flow_date: "2026-10-12",
        state: "running",
        etag: "7",
        saved_seconds: 75,
        segment_start_time: new Date().toISOString(),
      };
      return state.timer;
    });
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    await expect(
      page.getByRole("list", { name: "Today's steps" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start: Synthetic first step" }),
    ).toBeDisabled();
    await expect(page.locator(".plus-focus-block.is-current")).toHaveCount(0);
    await expect(page.locator(".plus-timer-bar")).toContainText(
      "Synthetic first step",
    );
    await page
      .getByRole("button", { name: "Adjust plan", exact: true })
      .click();
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    await expect(
      page.getByRole("list", { name: "Today's steps" }),
    ).toBeVisible();
    const after = await worker.evaluate(
      () =>
        (
          globalThis as unknown as {
            plannerState: { timer: Record<string, unknown> };
          }
        ).plannerState.timer,
    );
    expect(after).toEqual(before);
    expect((await plannerDays(worker))["2026-10-12"]).toEqual(["child"]);
    // The floating bar stays centred on the Focus column when the sidebar collapses.
    const offset = () =>
      page.locator("todoist-plus-view").evaluate((host) => {
        const root = host.shadowRoot!;
        const column = root
          .querySelector(".plus-root")!
          .getBoundingClientRect();
        const bar = root
          .querySelector(".plus-timer-bar")!
          .getBoundingClientRect();
        return Math.abs(
          bar.left + bar.width / 2 - (column.left + column.width / 2),
        );
      });
    await expect.poll(offset).toBeLessThanOrEqual(1);
    await page.evaluate(() => {
      document.querySelector("aside")!.style.display = "none";
      document.querySelector("main")!.style.marginLeft = "0";
    });
    await expect.poll(offset).toBeLessThanOrEqual(1);
  } finally {
    await context.close();
  }
});
