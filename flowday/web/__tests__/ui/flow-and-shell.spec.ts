import { test, expect } from "@playwright/test";
import {
  completedRow,
  dragFlowCardToFlowCard,
  dragTaskToEmptyFlow,
  flowCard,
  flowCardById,
  IN_THREE_DAYS,
  IN_TWO_DAYS,
  openApp,
  resetAppState,
  seedAppState,
  simulateTodoistOrphanSweep,
  taskPoolCard,
  TODAY,
  TOMORROW,
} from "./helpers/e2e";

test.beforeEach(async ({ request }) => {
  await resetAppState(request);
});

test("[UI-004] Quick add, search, and drag a local task into today flow", async ({
  page,
  request,
}) => {
  await seedAppState(request, "shell-empty");
  await openApp(page);

  await page.getByTestId("quick-add-input").fill("Write docs");
  await page.getByTestId("quick-add-submit").click();

  await page.getByPlaceholder("Search tasks...").fill("docs");
  await expect(taskPoolCard(page, "Write docs")).toBeVisible();

  await dragTaskToEmptyFlow(page, "Write docs");

  await expect(flowCard(page, "Write docs")).toBeVisible();
});

test("[UI-005] Flow card title, estimate, and note edits persist across reload", async ({
  page,
  request,
}) => {
  await seedAppState(request, "single-flow-task");
  await openApp(page);

  const card = flowCardById(page, "flow-task-1");
  await card.hover();
  await card.getByTestId("edit-local-title").click();
  await card.getByTestId("edit-local-title-input").fill("Deep work session");
  await card.getByTestId("edit-local-title-input").press("Enter");

  await card.getByText("45m est").click();
  await page.getByRole("button", { name: "1h" }).click();

  await card.getByRole("button", { name: "Toggle notes" }).click();
  await card.getByRole("textbox").fill("Remember edge cases");
  await page.waitForTimeout(700);

  await page.reload();

  await expect(flowCard(page, "Deep work session")).toBeVisible();
  await expect(flowCard(page, "Deep work session").getByRole("button", { name: "1h est" })).toBeVisible();
  await expect(page.getByText("Remember edge cases")).toBeVisible();
});

test("[UI-033] Custom estimate input commits when the popover closes", async ({
  page,
  request,
}) => {
  // single-flow-task seeds the card with estimatedMins=45.
  await seedAppState(request, "single-flow-task");
  await openApp(page);

  const card = flowCardById(page, "flow-task-1");
  await card.getByText("45m est").click();

  // Type a custom value, then click outside the popover instead of pressing Enter.
  // The value must still persist — losing typed input on click-away is the
  // unfriendly behaviour this test guards against.
  await page.getByTestId("estimate-custom-input").fill("75");
  // Click on the card title area, which is outside the popover.
  await page.getByText("Deep work block").first().click();

  await expect(card.getByRole("button", { name: "1h 15m est" })).toBeVisible();

  // Reload to confirm it actually persisted to the server, not just to local state.
  await page.reload();
  await expect(
    flowCardById(page, "flow-task-1").getByRole("button", { name: "1h 15m est" })
  ).toBeVisible();
});

test("[UI-009] Skip, complete, undo, and return-to-pool update flow state", async ({
  page,
  request,
}) => {
  await seedAppState(request, "two-flow-tasks");
  await openApp(page);

  await expect(flowCardById(page, "flow-task-a")).toBeVisible();

  const initialOrder = await page
    .locator('[data-testid="flow-task-card"]')
    .evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-task-id"))
    );
  expect(initialOrder).toEqual(["flow-task-a", "flow-task-b"]);

  await flowCard(page, "Inbox zero").getByRole("button", { name: "Skip task" }).click();

  const skippedOrder = await page
    .locator('[data-testid="flow-task-card"]')
    .evaluateAll((cards) =>
      cards.map((card) => card.getAttribute("data-task-id"))
    );
  expect(skippedOrder).toEqual(["flow-task-b", "flow-task-a"]);

  await flowCard(page, "Inbox zero").getByRole("button", { name: "Complete task" }).click();
  await expect(completedRow(page, "Inbox zero")).toBeVisible();

  await completedRow(page, "Inbox zero").getByRole("button", { name: "Undo complete task" }).click();
  await expect(flowCard(page, "Inbox zero")).toBeVisible();

  await flowCard(page, "Inbox zero").getByRole("button", { name: "Return to pool" }).click();
  await expect(flowCard(page, "Inbox zero")).toHaveCount(0);
  await expect(taskPoolCard(page, "Inbox zero")).toBeVisible();
});

test("[UI-010] Deleted-task dialog restores a soft-deleted local task", async ({
  page,
  request,
}) => {
  await seedAppState(request, "shell-empty");
  await openApp(page);

  await page.getByTestId("quick-add-input").fill("Restore me");
  await page.getByTestId("quick-add-submit").click();

  const poolCard = taskPoolCard(page, "Restore me");
  await poolCard.hover();
  await poolCard.getByTitle("Delete task").click();

  await expect.poll(async () => {
    const response = await request.get("/api/tasks/deleted");
    const deletedTasks = (await response.json()) as Array<{ title: string }>;
    return deletedTasks.some((task) => task.title === "Restore me");
  }).toBe(true);

  const deletedResponsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/tasks/deleted") &&
      response.request().method() === "GET"
  );
  await page.getByRole("button", { name: "Deleted tasks" }).click();
  const deletedResponse = await deletedResponsePromise;
  const deletedTasks = (await deletedResponse.json()) as Array<{ title: string }>;
  expect(deletedTasks.some((task) => task.title === "Restore me")).toBe(true);
  await expect(page.getByRole("heading", { name: "Deleted Tasks" })).toBeVisible();
  await page.getByPlaceholder("Search deleted...").fill("Restore me");
  await expect(page.getByText("Search results (1)")).toBeVisible();
  await expect(page.getByText("Restore me")).toBeVisible();
  await page.getByTitle("Restore task").click({ force: true });
  await page.keyboard.press("Escape");

  await expect(taskPoolCard(page, "Restore me")).toBeVisible();
});

test("[UI-016] Tasks deleted in Todoist disappear from the sidebar after sync", async ({
  page,
  request,
}) => {
  await seedAppState(request, "todoist-overdue");
  await openApp(page);

  await expect(page.getByRole("button", { name: /^Overdue/ })).toBeVisible();
  await expect(taskPoolCard(page, "Survives sync")).toBeVisible();
  await expect(taskPoolCard(page, "Deleted in Todoist")).toBeVisible();

  // Simulate the next sync: Todoist now only returns "td-keep". The other
  // task is treated as deleted-in-Todoist and gets sync-soft-deleted.
  await simulateTodoistOrphanSweep(request, ["td-keep"]);

  await page.reload();

  await expect(taskPoolCard(page, "Survives sync")).toBeVisible();
  await expect(taskPoolCard(page, "Deleted in Todoist")).toHaveCount(0);

  // Sync-deleted tasks must NOT clutter the trash dialog — the user manages
  // those in Todoist itself. The dialog is reserved for FlowDay-local deletes.
  await page.getByRole("button", { name: "Deleted tasks" }).click();
  await expect(page.getByRole("heading", { name: "Deleted Tasks" })).toBeVisible();
  await expect(page.getByText("Deleted in Todoist")).toHaveCount(0);
});

test("[UI-011] Settings, export, and analytics dialogs smoke test", async ({
  page,
  request,
}) => {
  await seedAppState(request, "analytics-seeded");
  await openApp(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

  await page.getByTestId("capacity-input").fill("1");
  await page.getByTestId("capacity-save").click();
  await page.keyboard.press("Escape");

  await expect(page.getByText("You've planned ~4h for a 1h day")).toBeVisible();

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("open-export-dialog").click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download-export").click();
  const download = await downloadPromise;
  expect(await download.path()).toBeTruthy();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Analytics" }).click();
  await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();
  await page.getByRole("button", { name: "Weekly Review" }).click();
  await expect(page.getByText("Daily Trend")).toBeVisible();
  await page.getByRole("button", { name: "Work Patterns" }).click();
  await expect(page.getByText("Peak Work Hours")).toBeVisible();
});

test("[UI-023] Future task pool follows the selected planning date", async ({
  page,
  request,
}) => {
  await seedAppState(request, "future-dated-pool");
  await openApp(page);

  await page.getByRole("button", { name: "Next day" }).click();
  await page.getByRole("button", { name: "Next day" }).click();

  await expect(taskPoolCard(page, "Plan for two days later")).toBeVisible();
  await expect(taskPoolCard(page, "Plan for three days later")).toHaveCount(0);

  await dragTaskToEmptyFlow(page, "Plan for two days later");
  await expect(flowCard(page, "Plan for two days later")).toBeVisible();

  await page.getByRole("button", { name: "Next day" }).click();

  await expect(taskPoolCard(page, "Plan for three days later")).toBeVisible();

  await dragTaskToEmptyFlow(page, "Plan for three days later");
  await expect(flowCard(page, "Plan for three days later")).toBeVisible();

  await page.getByRole("button", { name: "Previous day" }).click();
  await expect(flowCard(page, "Plan for two days later")).toBeVisible();
  await expect(flowCard(page, "Plan for three days later")).toHaveCount(0);
});

test("[UI-041] Dragging flow cards into a new order persists after reload", async ({
  page,
  request,
}) => {
  await seedAppState(request, "two-flow-tasks");
  await openApp(page);

  await dragFlowCardToFlowCard(page, "flow-task-b", "flow-task-a");

  await expect
    .poll(async () =>
      page
        .locator('[data-testid="flow-task-card"]')
        .evaluateAll((cards) =>
          cards.map((card) => card.getAttribute("data-task-id"))
        )
    )
    .toEqual(["flow-task-b", "flow-task-a"]);

  await page.reload();
  await expect
    .poll(async () =>
      page
        .locator('[data-testid="flow-task-card"]')
        .evaluateAll((cards) =>
          cards.map((card) => card.getAttribute("data-task-id"))
        )
    )
    .toEqual(["flow-task-b", "flow-task-a"]);
});

test("[UI-027] Date navigation arrows stay under the cursor across repeated clicks", async ({
  page,
  request,
}) => {
  await seedAppState(request, "future-dated-pool");
  await openApp(page);

  const nextDayButton = page.getByRole("button", { name: "Next day" });
  const buttonBox = await nextDayButton.boundingBox();
  expect(buttonBox).not.toBeNull();

  const clickX = buttonBox!.x + buttonBox!.width / 2;
  const clickY = buttonBox!.y + buttonBox!.height / 2;

  await page.mouse.move(clickX, clickY);
  await page.mouse.click(clickX, clickY);
  await expect(page.getByRole("button", { name: "Today" })).toBeVisible();

  // Click the same screen coordinates again to catch layout shifts that move
  // the hit target away from the next-day arrow.
  await page.mouse.click(clickX, clickY);

  await expect(taskPoolCard(page, "Plan for two days later")).toBeVisible();
  await expect(taskPoolCard(page, "Plan for three days later")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Today" })).toBeVisible();
});

test("[UI-042] Multi-day read-only columns keep tasks, notes, and done markers on the correct date", async ({
  page,
  request,
}) => {
  await seedAppState(request, "multi-day-readonly");
  await openApp(page);

  await page.getByRole("button", { name: "3-day view" }).click();

  const todayColumn = page.locator(
    `[data-testid="day-column"][data-date="${TODAY}"]`
  );
  const tomorrowColumn = page.locator(
    `[data-testid="day-column"][data-date="${TOMORROW}"]`
  );
  const inTwoDaysColumn = page.locator(
    `[data-testid="day-column"][data-date="${IN_TWO_DAYS}"]`
  );

  await expect(
    todayColumn.getByTestId("read-only-flow-task-row").filter({
      hasText: "Today writing block",
    })
  ).toBeVisible();
  await expect(todayColumn.getByText("Today note stays in today.")).toBeVisible();
  await expect(todayColumn.getByText("Tomorrow shipped task")).toHaveCount(0);

  await expect(
    tomorrowColumn.getByTestId("read-only-completed-task-row").filter({
      hasText: "Tomorrow shipped task",
    })
  ).toBeVisible();
  await expect(tomorrowColumn.getByText("Tomorrow done note.")).toBeVisible();
  await expect(tomorrowColumn.getByText("Today writing block")).toHaveCount(0);

  await expect(
    inTwoDaysColumn.getByTestId("read-only-flow-task-row").filter({
      hasText: "Two-day planning pass",
    })
  ).toBeVisible();
  await expect(inTwoDaysColumn.getByText("Two-day note stays put.")).toBeVisible();
  await expect(inTwoDaysColumn.getByText("Tomorrow shipped task")).toHaveCount(0);

  await page.getByRole("button", { name: "5-day view" }).click();
  const inThreeDaysColumn = page.locator(
    `[data-testid="day-column"][data-date="${IN_THREE_DAYS}"]`
  );
  await expect(
    inThreeDaysColumn.getByTestId("read-only-flow-task-row").filter({
      hasText: "Three-day research queue",
    })
  ).toBeVisible();
  await expect(inThreeDaysColumn.getByText("Today writing block")).toHaveCount(0);
});

test("[UI-043] Sidebar arranged and completed sections follow live flow changes", async ({
  page,
  request,
}) => {
  await seedAppState(request, "sidebar-section-state");
  await openApp(page);

  await expect(page.getByRole("button", { name: /Arranged\s*2/ })).toBeVisible();
  const completedSection = page.getByRole("button", { name: /Completed\s*1/ });
  await completedSection.click();

  const completedRowInSidebar = page
    .locator("div")
    .filter({ hasText: "Closed out task" })
    .filter({ hasText: "25:00" })
    .filter({ hasText: "30m" })
    .first();
  await expect(completedRowInSidebar).toBeVisible();

  await flowCard(page, "Inbox zero").getByRole("button", { name: "Complete task" }).click();

  await expect(page.getByRole("button", { name: /Arranged\s*1/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Completed\s*2/ })).toBeVisible();
  await expect(page.getByRole("complementary").getByText("Inbox zero")).toBeVisible();
});

test("[UI-044] Task pool tooltips render labels and markdown descriptions", async ({
  page,
  request,
}) => {
  await seedAppState(request, "tooltip-rich-task");
  await openApp(page);

  await taskPoolCard(page, "Rich tooltip task").hover();
  await expect(page.getByText("urgent", { exact: true })).toBeVisible();
  await expect(page.getByText("docs", { exact: true })).toBeVisible();
  await expect(page.getByText("Bullet alpha")).toBeVisible();
  await expect(page.getByText("Bullet beta")).toBeVisible();
  await expect(page.getByText("npm test")).toBeVisible();
});

test("[UI-050] Quick-labelled tasks collapse into a quiet arrangeable Quick block", async ({
  page,
  request,
}) => {
  await seedAppState(request, "quick-task-group");
  await openApp(page);

  const quickSection = page.getByRole("button", { name: "Quick 2", exact: true });
  await expect(quickSection).toBeVisible();
  await expect(taskPoolCard(page, "Draft roadmap section")).toBeVisible();
  await expect(taskPoolCard(page, "Answer Slack ping")).toHaveCount(0);
  const quickRow = page
    .getByTestId("quick-task-row")
    .filter({ hasText: "Answer Slack ping" });
  await expect(quickRow).toBeVisible();

  await quickSection.click();
  await expect(quickSection).toHaveAttribute("aria-expanded", "false");
  await expect(quickRow).toBeHidden();
  await expect(taskPoolCard(page, "Quick")).toBeVisible();
  await quickSection.click();
  await expect(quickSection).toHaveAttribute("aria-expanded", "true");
  await expect(quickRow).toBeVisible();

  await dragTaskToEmptyFlow(page, "Quick");

  const quickCard = flowCardById(page, "__flowday_quick__");
  await expect(quickCard).toBeVisible();
  await expect(quickCard.getByText("15m quick total")).toBeVisible();
  await expect(quickCard.getByRole("button", { name: "15m" })).toHaveCount(0);
  const quickListToggle = quickCard.getByTestId("quick-focus-list-toggle");
  await expect(quickListToggle).toHaveAttribute("aria-expanded", "false");
  await expect(taskPoolCard(page, "Quick")).toHaveCount(0);

  await expect(quickCard.getByRole("button", { name: "Start timer" })).toBeDisabled();
  await expect(quickCard.getByRole("button", { name: "Start Pomodoro" })).toBeDisabled();

  await quickListToggle.click();
  await expect(quickListToggle).toHaveAttribute("aria-expanded", "true");
  await expect(quickCard.getByText("Answer Slack ping")).toBeVisible();
  await expect(quickCard.getByText("Approve invoice")).toBeVisible();

  const answerQuickTask = quickCard
    .getByTestId("quick-focus-option")
    .filter({ hasText: "Answer Slack ping" });
  await answerQuickTask.getByRole("button", { name: "5m" }).click();
  await page.getByRole("button", { name: "30m" }).click();
  await expect(answerQuickTask.getByRole("button", { name: "30m" })).toBeVisible();
  await expect(quickCard.getByText("40m quick total")).toBeVisible();

  await quickCard
    .getByTestId("quick-focus-option")
    .filter({ hasText: "Answer Slack ping" })
    .getByRole("button", { name: "Answer Slack ping" })
    .click();
  await expect(quickCard.getByRole("button", { name: "Start timer" })).toBeEnabled();

  await quickCard.getByRole("button", { name: "Start Pomodoro" }).click();
  await expect(page.getByTestId("pomodoro-preset").first()).toHaveAttribute(
    "data-mins",
    "30"
  );
});

test("[UI-052] Quick task analytics use the focused real task instead of the Quick placeholder", async ({
  page,
  request,
}) => {
  await seedAppState(request, "quick-task-analytics");
  await openApp(page);

  await page.getByRole("button", { name: "Analytics" }).click();
  const analyticsDialog = page.getByRole("dialog", { name: "Analytics" });
  await expect(analyticsDialog.getByRole("cell", { name: "Answer Slack ping" })).toBeVisible();
  await expect(analyticsDialog.getByText("Unknown")).toHaveCount(0);
  await expect(analyticsDialog.getByRole("cell", { name: "Quick" })).toHaveCount(0);
});

test("[UI-051] Local tasks completed on a prior day stay out of overdue", async ({
  page,
  request,
}) => {
  await seedAppState(request, "local-completed-yesterday");
  await openApp(page);

  await expect(page.getByRole("button", { name: /Overdue\s*1/ })).toBeVisible();
  await expect(taskPoolCard(page, "Still overdue local")).toBeVisible();
  await expect(taskPoolCard(page, "Finished local yesterday")).toHaveCount(0);
});

test("[UI-045] Settings keep sync disabled until a key exists and preserve saved capacity", async ({
  page,
  request,
}) => {
  await seedAppState(request, "shell-empty");
  await openApp(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(page.getByTestId("settings-sync-now")).toBeDisabled();

  await page.getByTestId("settings-api-key-input").fill("todoist-test-key");
  await page.getByTestId("settings-save-api-key").click();
  await expect(page.getByTestId("settings-sync-now")).toBeEnabled();

  await page.getByTestId("capacity-input").fill("4.5");
  await page.getByTestId("capacity-save").click();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByTestId("settings-api-key-input")).toHaveAttribute(
    "placeholder",
    /key saved/
  );
  await expect(page.getByTestId("settings-sync-now")).toBeEnabled();
  await expect(page.getByTestId("capacity-input")).toHaveValue("4.5");
});

test("[UI-046] Export dialog uses the selected type, format, and date range for downloads", async ({
  page,
  request,
}) => {
  await seedAppState(request, "analytics-seeded");
  await openApp(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("open-export-dialog").click();

  await page.getByRole("button", { name: "Flow History" }).click();
  await page.getByRole("button", { name: "JSON" }).click();
  await page.getByTestId("export-start-date").fill(TODAY);
  await page.getByTestId("export-end-date").fill(TODAY);

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("download-export").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(
    `flowday-flows-${TODAY}-to-${TODAY}.json`
  );
});

test("[UI-047] Analytics navigation updates the rendered review window and empty states", async ({
  page,
  request,
}) => {
  await seedAppState(request, "analytics-multi-date");
  await openApp(page);

  await page.getByRole("button", { name: "Analytics" }).click();
  const analyticsDialog = page.getByRole("dialog", { name: "Analytics" });
  await expect(
    analyticsDialog.getByRole("cell", { name: "Today review block" })
  ).toBeVisible();

  await analyticsDialog
    .getByRole("button", { name: "Next analytics period" })
    .first()
    .click();
  await expect(analyticsDialog.getByText("No tasks planned for this day")).toBeVisible();

  await page.getByRole("button", { name: "Weekly Review" }).click();
  await expect(analyticsDialog.getByText("Today Project")).toBeVisible();

  await analyticsDialog
    .getByRole("button", { name: "Next analytics period" })
    .first()
    .click();
  await expect(analyticsDialog.getByText("Next Week Project")).toBeVisible();
  await expect(analyticsDialog.getByText("Today Project")).toHaveCount(0);
});

test("[UI-048] Collapsing and reopening the sidebar keeps the pool usable", async ({
  page,
  request,
}) => {
  await seedAppState(request, "shell-empty");
  await openApp(page);

  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(page.getByRole("button", { name: "Expand sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Expand sidebar" }).click();

  await expect(page.getByPlaceholder("Search tasks...")).toBeVisible();
  await page.getByTestId("quick-add-input").fill("After collapse");
  await page.getByTestId("quick-add-submit").click();
  await expect(taskPoolCard(page, "After collapse")).toBeVisible();
  await page.waitForTimeout(250);
  await dragTaskToEmptyFlow(page, "After collapse");
  await expect(flowCard(page, "After collapse")).toBeVisible();
});

test("[UI-030] Analytics daily and weekly review include misc time", async ({
  page,
  request,
}) => {
  await seedAppState(request, "analytics-seeded-with-misc");
  await openApp(page);

  await page.getByRole("button", { name: "Analytics" }).click();
  const analyticsDialog = page.getByRole("dialog", { name: "Analytics" });
  await expect(analyticsDialog).toBeVisible();

  await expect(analyticsDialog.getByText(/Misc time/)).toBeVisible();

  await page.getByRole("button", { name: "Weekly Review" }).click();
  await expect(analyticsDialog.getByText("Time by Project")).toBeVisible();
  await expect(analyticsDialog.getByText("Misc", { exact: true })).toBeVisible();
});

test("[UI-038] Analytics task breakdown uses 30m chunks and caps long bars", async ({
  page,
  request,
}) => {
  await seedAppState(request, "analytics-long-estimate");
  await openApp(page);

  await page.getByRole("button", { name: "Analytics" }).click();
  const analyticsDialog = page.getByRole("dialog", { name: "Analytics" });
  await expect(analyticsDialog).toBeVisible();
  await expect(analyticsDialog.getByText("30m chunks · capped at 4h")).toBeVisible();
  await expect(
    analyticsDialog.getByTestId("analytics-task-overflow-analytics-task-long")
  ).toHaveText("+1h");

  const longEstimate = analyticsDialog.getByTestId(
    "analytics-task-estimate-fill-analytics-task-long"
  );
  const shortEstimate = analyticsDialog.getByTestId(
    "analytics-task-estimate-fill-analytics-task-short"
  );

  const longBox = await longEstimate.boundingBox();
  const shortBox = await shortEstimate.boundingBox();

  expect(longBox).not.toBeNull();
  expect(shortBox).not.toBeNull();
  expect(longBox!.width).toBeGreaterThan(shortBox!.width * 6);
});

test.describe("analytics timezone", () => {
  test.use({ timezoneId: "America/Los_Angeles" });

  test("[UI-024] Analytics stats use the browser local timezone", async ({
    page,
    request,
  }) => {
    await seedAppState(request, "analytics-timezone-boundary");
    await openApp(page);

    await page.getByRole("button", { name: "Analytics" }).click();
    await expect(page.getByRole("heading", { name: "Analytics" })).toBeVisible();

    const statsResponsePromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/analytics?type=stats") &&
        response.request().method() === "GET"
    );

    await page.getByRole("button", { name: "Work Patterns" }).click();
    const statsResponse = await statsResponsePromise;

    const statsUrl = new URL(statsResponse.url());
    expect(statsUrl.searchParams.get("tz")).toBe("America/Los_Angeles");

    await expect(page.getByText("Peak Work Hours")).toBeVisible();
    await expect(page.getByText("Sun 17:00", { exact: true })).toBeVisible();
    await expect(page.getByText("Mon 0:00", { exact: true })).toHaveCount(0);
  });
});
