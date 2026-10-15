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
      name: "Reviewed: Inbox to clarify",
    });
    // The mail task counts; the review task in the same project does not.
    await expect(review.locator("li").first()).toContainText(
      "Inbox to clarify1",
    );
    await expect(
      review.getByRole("link", { name: /Open in Todoist/u }),
    ).toHaveAttribute("href", "https://app.todoist.com/app/project/mail");
    await inbox.check();
    await page.reload();
    await expect(
      page
        .getByRole("region", { name: "Weekly review" })
        .getByRole("checkbox", { name: "Reviewed: Inbox to clarify" }),
    ).toBeChecked();
    await page
      .getByRole("region", { name: "Weekly review" })
      .getByRole("button", { name: "Show" })
      .first()
      .click();
    const waiting = page.getByRole("list", { name: "Waiting" });
    await expect(waiting).toBeVisible();
    await expect(waiting.getByRole("listitem")).toHaveText([
      /^Synthetic old blocker/u,
      /^Synthetic recent wait/u,
    ]);
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
  } finally {
    await context.close();
  }
});
