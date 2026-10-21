import { expect, test } from "@playwright/test";
import { addDays, createTask } from "./planning-stub";

const NEWEST = "2026-10-21";
/** ListGtdDays' answer: 30 days, newest first, two of them not counted. */
function gtdDays() {
  return {
    gtd_days: Array.from({ length: 30 }, (_, index) => {
      const day = addDays(NEWEST, -index);
      if (index === 3 || index === 4) return { name: `gtdDays/${day}` };
      return {
        name: `gtdDays/${day}`,
        recorded: true,
        all_projects: {
          open_count: 40 - index,
          fresh_count: 10,
          recent_count: 8,
          stale_count: 7,
          old_count: 5,
          oldest_age_days: 61,
          overdue_count: index % 5,
          undated_count: 12,
          created_last_week_count: 9,
          completed_last_week_count: 11,
          closed_last_day_count: 2,
          open_mail_count: 4,
          complete: true,
        },
        inbox: {
          open_count: 12 - (index % 4),
          fresh_count: 5,
          recent_count: 3,
          stale_count: 2,
          old_count: 2,
          oldest_age_days: 44,
          overdue_count: 1,
          undated_count: 6,
          complete: true,
        },
      };
    }),
  };
}

test("GTD shows the newest day's counts, the latest review and three trends, and opens the review task", async ({
  page,
  request,
}) => {
  const review = await createTask(request, { title: "每周回顾 2026-W42" });
  await page.route("**/api/tasks/v1/gtdDays?*", (route) =>
    route.fulfill({ json: gtdDays() }),
  );
  await page.route("**/api/tasks/v1/weeklyReviews?*", (route) =>
    route.fulfill({
      json: {
        weekly_reviews: [
          {
            name: "weeklyReviews/2026-10-12",
            state: "created",
            review_task_id: review.id,
            create_time: "2026-10-18T17:00:00Z",
          },
        ],
      },
    }),
  );
  await page.goto("/#/today");
  await page.getByRole("link", { name: "GTD", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "GTD", level: 1 }),
  ).toBeVisible();
  const latest = page.getByRole("region", { name: NEWEST, exact: true });
  const facts: [string, string][] = [
    ["Inbox open", "12"],
    ["Oldest in Inbox", "44 days"],
    ["All open", "40"],
    ["Overdue", "0"],
    ["Undated", "12"],
    ["Created / completed, 7 days", "9 / 11"],
    ["Mail awaiting a decision, 1–14 days old", "4"],
  ];
  for (const [term, value] of facts)
    await expect(
      latest.locator("div").filter({ hasText: term }).locator("dd"),
    ).toHaveText(value);
  const reviewSection = page.getByRole("region", { name: "Weekly review" });
  await expect(reviewSection).toContainText("Week of 2026-10-12 · created");
  await expect(reviewSection).toContainText("Not yet");
  const charts = page.getByRole("figure");
  await expect(charts).toHaveCount(3);
  await expect(
    page.getByRole("img", { name: /^Open and overdue, the last 30 days\./ }),
  ).toBeVisible();
  // The numbers, oldest first, with the days not counted said so.
  const table = charts.first().locator("details");
  await table.locator("summary").click();
  await expect(table.locator("tbody tr")).toHaveCount(30);
  await expect(
    table.locator("tbody tr").filter({ hasText: addDays(NEWEST, -3) }),
  ).toContainText("Not counted");
  await page.setViewportSize({ width: 360, height: 740 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });
  await reviewSection.getByRole("button", { name: "Open task" }).click();
  await expect(
    page.getByRole("dialog").getByText("每周回顾 2026-W42"),
  ).toBeVisible();
});

test("GTD without counts says so", async ({ page }) => {
  await page.route("**/api/tasks/v1/gtdDays?*", (route) =>
    route.fulfill({
      json: {
        gtd_days: [
          { name: `gtdDays/${NEWEST}` },
          { name: "gtdDays/2026-10-20" },
        ],
      },
    }),
  );
  await page.route("**/api/tasks/v1/weeklyReviews?*", (route) =>
    route.fulfill({ json: {} }),
  );
  await page.goto("/#/gtd");
  await expect(
    page.getByRole("heading", { name: "No counts yet", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("No review task yet.")).toBeVisible();
  await expect(page.getByRole("figure")).toHaveCount(0);
});
