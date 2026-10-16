import {
  expect,
  test,
  type Locator,
  type Page,
  type Worker,
} from "@playwright/test";
import { addDeadlineTasks, launchPlanner } from "./planner-setup";

type DeadlineState = {
  calls: { path: string; method: string; body: Record<string, unknown> }[];
};
async function writes(worker: Worker) {
  return worker.evaluate(() =>
    (
      globalThis as unknown as { plannerState: DeadlineState }
    ).plannerState.calls.filter((call) => call.method !== "GET"),
  );
}
async function reads(worker: Worker) {
  return worker.evaluate(
    () =>
      (
        globalThis as unknown as { plannerState: DeadlineState }
      ).plannerState.calls.filter((call) => call.path === "/api/plus/v1/tasks")
        .length,
  );
}
const opacity = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).opacity);
/** Deadlines' own status region, beside the list so that it is read even while the list is closed. */
const announced = (page: Page) =>
  page.locator('.planning-deadlines + [role="status"]');
const right = async (locator: Locator) => {
  const box = (await locator.boundingBox())!;
  return box.x + box.width;
};

test("Deadlines lists each status at rest, shows its one action on hover or focus, and marks a task in progress", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await addDeadlineTasks(worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    const deadlines = page.locator(".planning-deadlines");
    await expect(deadlines.locator("summary")).toHaveText("Deadlines · 5");
    // Open by itself: something is past its deadline or in its start window.
    await expect(deadlines).toHaveAttribute("open", "");
    const list = page.getByRole("list", { name: "Deadlines" });
    await expect(list.locator(".planning-row-title")).toHaveText([
      "Quarterly report draft",
      "Submit the expense claim",
      "Prepare the visa documents",
      "Move house",
      "Renew the car insurance",
    ]);
    await expect(list.locator(".planning-row-status")).toHaveText([
      /^2 days past/u,
      /^Deadline tomorrow/u,
      /^5 days left/u,
      /^In progress · 12 days left/u,
      /^Deadline Nov 30/u,
    ]);
    // At rest a row is its title and one status: the actions keep their place but are not shown.
    const rows = list.getByRole("listitem");
    const actions = rows.locator(".planning-row-actions");
    await page.mouse.move(0, 0);
    for (const index of [0, 1, 2, 3, 4])
      expect(await opacity(actions.nth(index))).toBe("0");
    await rows.nth(0).hover();
    expect(await opacity(actions.nth(0))).toBe("1");
    expect(await opacity(actions.nth(1))).toBe("0");
    // Keyboard: Tab from the title reaches the row's action, which then shows.
    await page.mouse.move(0, 0);
    await rows
      .nth(4)
      .getByRole("button", { name: "Renew the car insurance", exact: true })
      .focus();
    await page.keyboard.press("Tab");
    const choose = list.getByRole("button", {
      name: "Choose when to start: Renew the car insurance",
    });
    await expect(choose).toBeFocused();
    expect(await opacity(actions.nth(4))).toBe("1");
    // The one colour is the days past.
    const danger = await list
      .locator(".planning-danger-text")
      .evaluateAll((elements) =>
        elements.map((element) => element.textContent),
      );
    expect(danger).toEqual(["2 days past"]);

    const before = await reads(worker);
    await list
      .getByRole("button", {
        name: "Mark in progress: Submit the expense claim",
      })
      .click();
    await expect(list.locator(".planning-row-status").nth(1)).toHaveText(
      /^In progress · Deadline tomorrow/u,
    );
    await expect(announced(page)).toHaveText(
      "Marked in progress: Submit the expense claim",
    );
    const next = list.getByRole("button", {
      name: "Mark in progress: Prepare the visa documents",
    });
    await expect(next).toBeFocused();
    // After a click, the focus left on the next row does not keep its action shown.
    await page.mouse.move(0, 0);
    expect(await opacity(actions.nth(2))).toBe("0");
    expect(await writes(worker)).toEqual([
      {
        path: "/api/plus/v1/tasks:setTaskPlan",
        method: "POST",
        body: {
          task_id: "claim",
          etag: "claim-1",
          request_id: expect.any(String),
          active: true,
        },
      },
    ]);
    // The confirmed task is merged; nothing is read again.
    expect(await reads(worker)).toBe(before);

    // Waiting rows carry the deadline; their actions show on hover as well.
    await page.getByText("Waiting · 2").click();
    const waiting = page.getByRole("list", { name: "Waiting" });
    await expect(waiting.locator(".planning-row-status")).toHaveText([
      // The untouched age follows the real clock; the deadline follows the plan's today.
      /^Untouched \d+ days · Deadline Oct 20, Tue$/u,
      /^Untouched \d+ days$/u,
    ]);
    // At rest every status ends against the edge, in both lists alike.
    for (const rows of [list, waiting]) {
      const edge = await right(rows);
      for (const status of await rows.locator(".planning-row-status").all())
        expect(Math.abs((await right(status)) - edge)).toBeLessThan(1);
    }
    expect(
      await opacity(waiting.locator(".planning-row-actions").first()),
    ).toBe("0");
    await waiting.getByRole("listitem").first().hover();
    expect(
      await opacity(waiting.locator(".planning-row-actions").first()),
    ).toBe("1");

    // Week keeps Deadlines below the calendar; task details say where the deadline stands.
    await page.getByRole("tab", { name: "Week", exact: true }).click();
    const calendar = (await page.locator(".planning-calendar").boundingBox())!;
    const below = (await page.locator(".planning-deadlines").boundingBox())!;
    expect(below.y).toBeGreaterThan(calendar.y + calendar.height);
    await list
      .getByRole("button", { name: "Prepare the visa documents", exact: true })
      .click();
    const editor = page.getByRole("region", { name: "Steps & timing" });
    await expect(
      editor.getByText("Start window open · 5 days left"),
    ).toBeVisible();
    await expect(
      editor.getByRole("button", { name: "Mark in progress" }),
    ).toBeVisible();
    await expect(editor.getByLabel("Start ahead").locator("option")).toHaveText(
      ["Not set", "1 day", "3 days", "7 days", "14 days", "30 days"],
    );
  } finally {
    await context.close();
  }
});

test("marking the last due row by keyboard keeps Deadlines open, with focus and the result announced", async () => {
  const { context, worker } = await launchPlanner();
  try {
    // One row in its start window and one without a lead: the list opens by itself.
    await addDeadlineTasks(worker, ["claim", "insurance"]);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    const deadlines = page.locator(".planning-deadlines");
    await expect(deadlines).toHaveAttribute("open", "");
    const list = page.getByRole("list", { name: "Deadlines" });
    await list
      .getByRole("button", { name: "Submit the expense claim", exact: true })
      .focus();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(list.locator(".planning-row-status").first()).toHaveText(
      /^In progress · Deadline tomorrow/u,
    );
    // Nothing is due any more; the list stays open and focus moves to the next row's action,
    // which shows, as keyboard focus does.
    await expect(deadlines).toHaveAttribute("open", "");
    const next = list.getByRole("button", {
      name: "Choose when to start: Renew the car insurance",
    });
    await expect(next).toBeFocused();
    expect(await opacity(list.locator(".planning-row-actions").nth(1))).toBe(
      "1",
    );
    await expect(announced(page)).toHaveText(
      "Marked in progress: Submit the expense claim",
    );
    expect(await writes(worker)).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("Focus's quiet line opens Review with Deadlines open and its summary focused", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await addDeadlineTasks(worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today?todoist-plus=focus");
    const line = page.getByRole("button", {
      name: "1 past deadline and 2 in their start window, not planned this week",
    });
    await expect(line).toHaveAttribute("title", "Show in Plan");
    await line.click();
    await expect(page).toHaveURL(/todoist-plus=plan/u);
    const summary = page.locator(".planning-deadlines > summary");
    await expect(summary).toBeFocused();
    await expect(page.locator(".planning-deadlines")).toHaveAttribute(
      "open",
      "",
    );
    await expect(
      page.getByRole("tab", { name: "Review", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    expect(await writes(worker)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("narrow Deadlines rows wrap their status and action under the title without overflowing", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await addDeadlineTasks(worker);
    const page = await context.newPage();
    // Under the 650px breakpoint, as in a narrow window.
    await page.setViewportSize({ width: 640, height: 900 });
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    const list = page.getByRole("list", { name: "Deadlines" });
    const row = list.getByRole("listitem").first();
    await expect(row).toBeVisible();
    const title = (await row.locator(".planning-row-title").boundingBox())!;
    const status = (await row.locator(".planning-row-status").boundingBox())!;
    const action = (await row.locator(".planning-row-action").boundingBox())!;
    expect(status.y).toBeGreaterThanOrEqual(title.y + title.height - 1);
    expect(Math.abs(action.y - status.y)).toBeLessThan(4);
    expect(
      await list.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});
