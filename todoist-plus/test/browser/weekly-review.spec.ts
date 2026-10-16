import { expect, test, type Worker } from "@playwright/test";
import { launchPlanner } from "./planner-setup";

type ReviewState = {
  tasks: Record<string, unknown>[];
  review: Record<string, unknown>;
  calls: { path: string; method: string; body: Record<string, unknown> }[];
};
async function writes(worker: Worker) {
  return worker.evaluate(() =>
    (
      globalThis as unknown as { plannerState: ReviewState }
    ).plannerState.calls.filter((call) => call.method !== "GET"),
  );
}

test("the review task's link opens the checklist; ticks survive a reload and only Finish review completes the task", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await worker.evaluate(() => {
      const state = (globalThis as unknown as { plannerState: ReviewState })
        .plannerState;
      const task = (id: string, title: string, fields = {}) => ({
        id,
        title,
        area: "work",
        stage: "none",
        etag: `${id}-1`,
        ...fields,
      });
      state.tasks.push(
        task("waiting-new", "Synthetic recent wait", {
          labels: ["waiting"],
          update_time: "2026-10-12T09:00:00Z",
        }),
        task("waiting-old", "Synthetic old blocker", {
          labels: ["blocked"],
          update_time: "2026-09-20T09:00:00Z",
        }),
        task("parked", "Synthetic someday idea", {
          labels: ["parked"],
          update_time: "2026-08-01T09:00:00Z",
        }),
        task("mail", "Synthetic mail subject", { project_id: "mail" }),
        task("review", "Synthetic weekly review", { project_id: "mail" }),
      );
      state.review = { inbox_project_id: "mail", review_task_id: "review" };
    });
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today?todoist-plus=review");
    const review = page.getByRole("region", { name: "Weekly review" });
    await expect(review).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Plan", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    const inbox = review.getByRole("checkbox", {
      name: "Reviewed: Mail to clarify",
    });
    // The mail task counts; the review task in the same project does not.
    await expect(review.locator("li").first()).toContainText(
      "Mail to clarify1",
    );
    // The mail line opens Plus's Mailbox, not the native project (checked at the end).
    await expect(review.getByRole("link")).toHaveCount(0);
    await inbox.check();
    await page.reload();
    await expect(
      page
        .getByRole("region", { name: "Weekly review" })
        .getByRole("checkbox", { name: "Reviewed: Mail to clarify" }),
    ).toBeChecked();
    await page
      .getByRole("region", { name: "Weekly review" })
      .getByRole("button", { name: "Show" })
      .first()
      .click();
    // The Waiting lane, oldest untouched first; the mail task is no card.
    const waiting = page.getByRole("region", { name: "Waiting", exact: true });
    await expect(waiting).toBeFocused();
    await expect(waiting.locator(".planning-outcome-title")).toHaveText([
      "Synthetic old blocker",
      "Synthetic recent wait",
    ]);
    await expect(
      page.locator(".review-board").getByText("Synthetic mail subject"),
    ).toHaveCount(0);
    expect(await writes(worker)).toEqual([]);
    await page
      .getByRole("region", { name: "Weekly review" })
      .getByRole("button", { name: "Finish review" })
      .click();
    await expect(
      page.getByRole("region", { name: "Weekly review" }),
    ).toContainText("Review task completed");
    expect(await writes(worker)).toEqual([
      {
        path: "/api/plus/v1/tasks:completeTask",
        method: "POST",
        body: { task_id: "review", request_id: expect.any(String) },
      },
    ]);
    await page
      .getByRole("region", { name: "Weekly review" })
      .locator("li")
      .first()
      .getByRole("button", { name: "Open" })
      .click();
    await expect(page).toHaveURL(/todoist-plus=mailbox/u);
    await expect(
      page.getByRole("heading", { name: "Mail", level: 1 }),
    ).toBeFocused();
  } finally {
    await context.close();
  }
});

test("keyboard focus stays in the review after its actions, and Sunday's keep writes the commitment once", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await worker.evaluate(() => {
      const state = (globalThis as unknown as { plannerState: ReviewState })
        .plannerState;
      const task = (id: string, title: string, fields = {}) => ({
        id,
        title,
        area: "work",
        stage: "none",
        etag: `${id}-1`,
        ...fields,
      });
      state.tasks.push(
        task("wait", "Synthetic wait", { labels: ["waiting"] }),
        task("idea-old", "Synthetic old idea", {
          labels: ["parked"],
          update_time: "2026-08-01T09:00:00Z",
        }),
        task("idea-new", "Synthetic new idea", {
          labels: ["onhold"],
          update_time: "2026-09-01T09:00:00Z",
        }),
      );
      // The account's Sunday, the last day of the week of 2026-10-12.
      state.review = { today: "2026-10-18" };
    });
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today?todoist-plus=review");
    const review = page.getByRole("region", { name: "Weekly review" });
    await expect(review).toBeVisible();
    await review.getByRole("button", { name: "Show" }).nth(1).click();
    // Keeping an item moves focus to the next one, then to the line once none is left.
    await review
      .getByRole("button", { name: "Keep: Synthetic old idea" })
      .press("Enter");
    await expect(
      review.getByRole("button", { name: "Keep: Synthetic new idea" }),
    ).toBeFocused();
    await expect(review.getByRole("status")).toHaveText(
      "Kept: Synthetic old idea",
    );
    await page.keyboard.press("Enter");
    await expect(
      review.getByRole("checkbox", { name: "Reviewed: Someday" }),
    ).toBeFocused();
    // Sunday: keeping this week's commitment resends it; focus moves to the line's toggle.
    await review
      .getByRole("button", { name: "Choose commitments to keep (1)" })
      .click();
    await review
      .getByRole("button", {
        name: "Keep for next week: Synthetic weekly outcome",
      })
      .press("Enter");
    await expect(
      review.getByText("Kept for next week", { exact: true }),
    ).toBeVisible();
    await expect(review.getByRole("button", { name: "Hide" })).toBeFocused();
    expect(await writes(worker)).toEqual([
      {
        path: "/api/plus/v1/tasks:setTaskPlan",
        method: "POST",
        body: {
          task_id: "parent",
          etag: "parent-1",
          request_id: expect.any(String),
          stage: "committed",
        },
      },
    ]);
    // The Waiting jump focuses the Waiting lane, with the keyboard's ring; closing returns to the
    // toolbar button.
    await review.getByRole("button", { name: "Show" }).first().press("Enter");
    const waiting = page.getByRole("region", { name: "Waiting" });
    await expect(waiting).toBeFocused();
    expect(
      await waiting.evaluate((lane) => getComputedStyle(lane).outlineStyle),
    ).toBe("solid");
    await review.getByRole("button", { name: "Close" }).click();
    await expect(
      page.getByRole("button", { name: "Weekly review" }),
    ).toBeFocused();
  } finally {
    await context.close();
  }
});
