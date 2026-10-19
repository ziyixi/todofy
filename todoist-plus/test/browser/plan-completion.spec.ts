import { expect, test } from "@playwright/test";
import {
  addDeadlineTasks,
  addCommitments,
  controlWrites,
  launchPlanner,
  plannerWrites,
} from "./planner-setup";

test("Committed spans the board below candidates and lays its cards out horizontally without overflow", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await addCommitments(worker);
    await addDeadlineTasks(worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
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
        const candidates = page.locator(
          '.review-lane:not([data-lane="committed"])',
        );
        const positions = await candidates.evaluateAll((nodes) =>
          nodes.map((node) => ({
            x: node.getBoundingClientRect().x,
            y: node.getBoundingClientRect().y,
          })),
        );
        expect(positions).toHaveLength(5);
        for (const position of positions)
          expect(position.y).toBeCloseTo(positions[0]!.y, 0);
        expect(positions[1]!.x).toBeGreaterThan(positions[0]!.x);
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
    expect(await plannerWrites(worker)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("Plan completes a tray Step, a scheduled Step and an outcome through the existing completion endpoint", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
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
    await expect(tray.locator('[data-task-id="second"]')).toHaveCount(0);
    const day = page.locator('.planning-calendar-day[data-date="2026-10-13"]');
    await day
      .getByRole("button", {
        name: "Complete task: Synthetic first step",
        exact: true,
      })
      .click();
    await expect(day.locator('[data-task-id="child"]')).toHaveCount(0);
    await expect(day.locator('[data-task-id="local-one"]')).toBeVisible();
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
    await expect(committed.locator('[data-outcome-id="parent"]')).toHaveCount(
      0,
    );
    const completions = (await plannerWrites(worker)).filter((call) =>
      call.path.endsWith("/tasks:completeTask"),
    );
    expect(
      completions.map((call) => [call.body.task_id, call.body.flow_date]),
    ).toEqual([
      ["second", "2026-10-13"],
      ["child", "2026-10-13"],
      ["parent", "2026-10-13"],
    ]);
    expect(new Set(completions.map((call) => call.body.request_id)).size).toBe(
      3,
    );
    for (const call of completions)
      expect(call.body.request_id).toMatch(/^[a-f0-9-]{36}$/u);
  } finally {
    await context.close();
  }
});

test("failed Plan completion keeps the card and retries the same completion identity", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    const quarter = page.getByRole("region", { name: "Quarter", exact: true });
    await controlWrites(worker, { fail: true });
    await quarter
      .getByRole("button", {
        name: "Complete task: Synthetic quarter outcome",
        exact: true,
      })
      .click();
    await expect(
      page.getByText("Synthetic save unavailable", { exact: true }),
    ).toBeVisible();
    await expect(quarter.locator('[data-outcome-id="quarter"]')).toBeVisible();
    await quarter
      .getByRole("button", {
        name: "Complete task: Synthetic quarter outcome",
        exact: true,
      })
      .click();
    await expect(quarter.locator('[data-outcome-id="quarter"]')).toHaveCount(0);
    const completions = (await plannerWrites(worker)).filter((call) =>
      call.path.endsWith("/tasks:completeTask"),
    );
    expect(completions).toHaveLength(2);
    expect(completions[0]!.body.request_id).toBe(
      completions[1]!.body.request_id,
    );
  } finally {
    await context.close();
  }
});
