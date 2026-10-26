import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFocus, stubPlanning, tasksToday } from "./planning-stub";

test.use({
  serviceWorkers: "block",
  viewport: { width: 1440, height: 1000 },
  timezoneId: "UTC",
});

async function dragToDay(page: Page, source: Locator, target: Locator) {
  await source.scrollIntoViewIfNeeded();
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    from.x + from.width / 2 + 12,
    from.y + from.height / 2,
    { steps: 4 },
  );
  await page.mouse.move(to.x + to.width / 2, to.y + 35, { steps: 18 });
  await page.mouse.up();
}

test("Quick keeps its configured clock when dragged to a calendar day and needs no estimate", async ({
  page,
  request,
}, testInfo) => {
  const today = await tasksToday();
  const id = "quick-clock-native";
  const untimedId = "quick-untimed-native";
  const title = "Synthetic timed Quick action";
  const state = await stubPlanning(page, {
    tasks: [
      {
        id,
        title,
        planning_flags: ["quick"],
        due_date: today,
        due_datetime: `${today}T04:25:00Z`,
        due_timezone: "Asia/Tokyo",
      },
      {
        id: untimedId,
        title: "Synthetic untimed Quick action",
        planning_flags: ["quick"],
      },
    ],
  });
  const before = await (await request.get(`/api/tasks/v1/tasks/${id}`)).json();
  await page.goto(`/?task=${id}#/inbox`);
  const native = page.getByRole("dialog", {
    name: "Task details",
    exact: true,
  });
  await expect(
    native.getByRole("radio", { name: "Quick", exact: true }),
  ).toBeChecked();
  await expect(
    native.getByRole("spinbutton", { name: "Duration (minutes)", exact: true }),
  ).toHaveCount(0);
  await native.getByRole("button", { name: "Date", exact: true }).click();
  await native
    .getByRole("button", { name: "Time options", exact: true })
    .click();
  await expect(native.getByLabel("Time", { exact: true })).toHaveValue("13:25");
  await expect(native.getByLabel("Time", { exact: true })).toBeEnabled();
  await native.locator(".schedule-popup").press("Escape");
  await native
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();

  await page.goto("/#/plan");
  await page.getByRole("tab", { name: "Week", exact: true }).click();
  const quick = page.getByRole("region", { name: "Quick tasks", exact: true });
  await quick
    .getByRole("button", { name: `${title}, Unassigned`, exact: true })
    .click();
  const planning = page.getByRole("dialog", { name: title, exact: true });
  await expect(planning).toBeVisible();
  await expect(
    planning.getByRole("combobox", { name: `Estimate: ${title}`, exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  const day = page.locator(`.planning-calendar-day[data-date="${today}"]`);
  await dragToDay(
    page,
    quick.getByRole("button", { name: `${title}, Unassigned`, exact: true }),
    day.locator(".planning-day-body"),
  );
  const scheduled = day.locator(`[data-task-id="${id}"]`);
  await expect(scheduled).toBeVisible();
  await expect(
    scheduled.locator(".planning-calendar-step-meta strong"),
  ).toHaveText("13:25");
  await expect(day.locator(".planning-day-heading small")).not.toContainText(
    "?",
  );
  await dragToDay(
    page,
    quick.getByRole("button", {
      name: "Synthetic untimed Quick action, Unassigned",
      exact: true,
    }),
    day.locator(".planning-day-body"),
  );
  await expect(
    day.locator(
      `[data-task-id="${untimedId}"] .planning-calendar-step-meta strong`,
    ),
  ).toHaveText("Quick");
  await expect(day.locator(".planning-day-heading small")).not.toContainText(
    "?",
  );
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("quick-calendar-clock.png"),
  });
  await page.reload();
  await expect(
    day.locator(`[data-task-id="${id}"] .planning-calendar-step-meta strong`),
  ).toHaveText("13:25");
  const after = await (await request.get(`/api/tasks/v1/tasks/${id}`)).json();
  expect(after.due_date).toBe(before.due_date);
  expect(after.due_datetime).toBe(before.due_datetime);
  expect(after.due_timezone).toBe(before.due_timezone);
  expect(after.duration_minutes ?? 0).toBe(before.duration_minutes ?? 0);
  const days = (await readFocus(today, today)).days as {
    task_ids?: string[];
  }[];
  const shownIds = await day
    .locator(".planning-calendar-step:not(.is-done)")
    .evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-task-id")),
    );
  expect(days[0]?.task_ids).toEqual(shownIds);
  expect([...shownIds].sort()).toEqual([id, untimedId].sort());
  expect(state.tasksRequests.filter((call) => call.method === "PATCH")).toEqual(
    [],
  );
});
