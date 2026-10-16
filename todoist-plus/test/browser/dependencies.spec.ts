import { expect, test, type Page, type Worker } from "@playwright/test";
import { addDependencyTasks, launchPlanner } from "./planner-setup";

type DependencyState = {
  tasks: Record<string, unknown>[];
  dependencies: Record<string, unknown>[];
  deleted: string[];
  calls: { path: string; method: string; body: Record<string, unknown> }[];
};
/**
 * What happens in Todoist meanwhile: a task completed (gone from the active list) or deleted (gone,
 * and Todofy's check finds the deletion), or a recurring task's counter after a completion.
 */
async function inTodoist(
  worker: Worker,
  change: { completed?: string; deleted?: string; counted?: [string, number] },
) {
  await worker.evaluate((change) => {
    const state = (globalThis as unknown as { plannerState: DependencyState })
      .plannerState;
    const gone = change.completed ?? change.deleted;
    if (gone) state.tasks = state.tasks.filter((task) => task.id !== gone);
    if (change.deleted) state.deleted.push(change.deleted);
    if (change.counted) {
      const [id, count] = change.counted;
      state.tasks.find((task) => task.id === id)!.completed_count = count;
    }
  }, change);
}
async function writes(worker: Worker, path: string) {
  return worker.evaluate(
    (path) =>
      (
        globalThis as unknown as { plannerState: DependencyState }
      ).plannerState.calls
        .filter((call) => call.path.endsWith(path))
        .map((call) => call.body),
    path,
  );
}
const lane = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });
const card = (page: Page, title: string) =>
  page.locator(".review-draggable", {
    has: page.getByRole("button", { name: new RegExp(`^${title},`, "u") }),
  });
const dependencies = (page: Page) => page.locator(".plus-dependencies").first();

test("a task that waits for another is in Waiting or keeps its lane saying so, and the details pick a prerequisite as you type", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await addDependencyTasks(worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    // No stage label: Waiting, not Start now, although the program's start window is open.
    await expect(
      lane(page, "Waiting").locator(".planning-outcome-title"),
    ).toHaveText(["Plan the launch program", "Tidy the bookshelf"]);
    await expect(lane(page, "Start now")).toHaveCount(0);
    await expect(
      lane(page, "Waiting").locator(".planning-outcome-status"),
    ).toHaveText([
      "Waiting for “Book the venue” · Deadline Oct 20",
      "Waiting for “Send the invitations”",
    ]);
    await expect(
      card(page, "Send the invitations").locator(".planning-outcome-counts"),
    ).toHaveText("1 step · 0 planned");

    await page.getByRole("button", { name: /^Send the invitations,/u }).click();
    const section = dependencies(page);
    await expect(
      section.getByRole("heading", { name: "Depends on" }),
    ).toBeVisible();
    await expect(
      section.getByText("“Tidy the bookshelf” is waiting for this"),
    ).toBeVisible();
    await section.getByRole("button", { name: "Add a dependency" }).click();
    const search = section.getByRole("combobox", {
      name: "Search tasks or parents",
    });
    await expect(search).toBeFocused();
    await search.fill("b");
    // The shelf already waits for the invitations: shown greyed with the reason, never chosen.
    await expect(section.getByRole("option")).toHaveText([
      "Book the venue",
      "Tidy the bookshelfWould wait on each other",
    ]);
    await expect(
      section.getByRole("option", { name: /Tidy the bookshelf/u }),
    ).toHaveAttribute("aria-disabled", "true");
    // Playwright waits for an aria-disabled option to be enabled; a forced click shows it does nothing.
    await section
      .getByRole("option", { name: /Tidy the bookshelf/u })
      .click({ force: true });
    await expect(section.getByRole("combobox")).toBeVisible();
    expect(await writes(worker, "/tasks:setTaskDependency")).toEqual([]);
    // Escape closes only the picker; the dialog stays open.
    await search.press("Escape");
    await expect(section.getByRole("combobox")).toHaveCount(0);
    await expect(page.locator("dialog.plus-dialog[open]")).toHaveCount(1);
    await expect(
      section.getByRole("button", { name: "Add a dependency" }),
    ).toBeFocused();
    await section
      .getByRole("button", { name: "Add a dependency" })
      .press("Enter");
    await section.getByRole("combobox").fill("venue");
    await section.getByRole("combobox").press("Enter");
    await expect(
      section.getByRole("button", { name: "Book the venue", exact: true }),
    ).toBeVisible();
    expect(await writes(worker, "/tasks:setTaskDependency")).toEqual([
      expect.objectContaining({
        task_id: "invite",
        prerequisite_id: "venue",
        waits: true,
      }),
    ]);
    // The row's remove action shows on hover or keyboard focus only.
    const remove = section.getByRole("button", {
      name: "Remove dependency: Book the venue",
    });
    await page.mouse.move(2, 2);
    await expect(remove).toHaveCSS("opacity", "0");
    await section.locator(".plus-dependency").hover();
    await expect(remove).toHaveCSS("opacity", "1");
    // Nothing changed in Todoist: no Sync-shaped write, only the dependency.
    expect((await writes(worker, "/tasks:setTaskPlan")).length).toBe(0);
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog.plus-dialog[open]")).toHaveCount(0);
    // A commitment keeps its lane; its status says what it waits for, in place of the step counts.
    await expect(
      card(page, "Send the invitations").locator(".planning-outcome-status"),
    ).toHaveText("Waiting for “Book the venue”");
    await expect(
      lane(page, "Committed").locator(".planning-outcome-title"),
    ).toContainText(["Send the invitations"]);

    // The venue is completed in Todoist. The next complete read misses it: Todofy is asked once, and
    // both tasks are ready. Nothing is rescheduled or relabelled.
    await inTodoist(worker, { completed: "venue" });
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect(
      lane(page, "Waiting").locator(".planning-outcome-title"),
    ).toHaveText(["Tidy the bookshelf"]);
    await expect(
      lane(page, "Start now").locator(".planning-outcome-title"),
    ).toHaveText(["Plan the launch program"]);
    await expect(
      card(page, "Plan the launch program").locator(".planning-outcome-status"),
    ).toHaveText("7 days left");
    await expect(
      card(page, "Send the invitations").locator(".planning-outcome-counts"),
    ).toHaveText("1 step · 0 planned");
    expect(await writes(worker, "/tasks:resolveDependencies")).toEqual([
      expect.objectContaining({ task_ids: ["venue"] }),
    ]);
    await page.getByRole("button", { name: /^Send the invitations,/u }).click();
    await expect(
      dependencies(page).getByText(
        "Everything it waits for is done — ready to start",
      ),
    ).toBeVisible();
    expect((await writes(worker, "/tasks:setTaskPlan")).length).toBe(0);
  } finally {
    await context.close();
  }
});

test("a recurring prerequisite waits for its next completion; a deleted one is told once in Review", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await addDependencyTasks(worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    await page.getByRole("button", { name: /^Send the invitations,/u }).click();
    const section = dependencies(page);
    await section.getByRole("button", { name: "Add a dependency" }).click();
    await section.getByRole("combobox").fill("sync");
    await section.getByRole("combobox").press("Enter");
    await expect(section.locator(".plus-dependency")).toHaveText([
      "Weekly launch syncAfter its next completion",
    ]);
    expect(
      await worker.evaluate(() =>
        (
          globalThis as unknown as { plannerState: DependencyState }
        ).plannerState.dependencies.at(-1),
      ),
    ).toMatchObject({ baseline_completed_count: 4 });
    await page.keyboard.press("Escape");
    await expect(
      card(page, "Send the invitations").locator(".planning-outcome-status"),
    ).toHaveText("Waiting for “Weekly launch sync”");
    // Completed once in Todoist: the counter rises and the task stays; then the venue is deleted.
    await inTodoist(worker, { counted: ["weekly", 5] });
    await inTodoist(worker, { deleted: "venue" });
    await page.getByRole("button", { name: "Refresh" }).click();
    const notice = page.locator(".planning-dependency-notice");
    await expect(notice).toHaveText(
      "“Plan the launch program” no longer waits — the task it waited for was deleted.",
    );
    await expect(notice).toHaveAttribute("role", "status");
    await expect(
      card(page, "Send the invitations").locator(".planning-outcome-counts"),
    ).toHaveText("1 step · 0 planned");
    await expect(
      lane(page, "Waiting").locator(".planning-outcome-title"),
    ).toHaveText(["Tidy the bookshelf"]);
    // Told once: after a page load it is gone, with nothing left to settle.
    await page.reload();
    await expect(lane(page, "Committed")).toBeVisible();
    await expect(notice).toHaveText("");
    expect(await writes(worker, "/tasks:resolveDependencies")).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("the native Steps & timing has the same section, and a prerequisite opens its Todoist page", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await addDependencyTasks(worker);
    await worker.evaluate(() =>
      (
        globalThis as unknown as { plannerState: DependencyState }
      ).plannerState.dependencies.push({
        task_id: "invite",
        prerequisite_id: "venue",
      }),
    );
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/task/invite");
    await page.evaluate(() => {
      document
        .querySelector("#content")!
        .insertAdjacentHTML(
          "beforeend",
          `<section data-testid="task-details-modal"><div data-testid="task-selection-list-container"><div data-item-id="invite"></div></div><div data-testid="task-main-content-container"><h2>Native detail</h2></div></section>`,
        );
      // A page listener that would close Todoist's modal on Escape.
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") document.body.dataset.escaped = "yes";
      });
    });
    await page
      .getByRole("button", { name: "Steps & timing", exact: true })
      .click();
    const section = dependencies(page);
    await expect(section.locator(".plus-dependency")).toHaveText([
      "Book the venue",
    ]);
    await section.getByRole("button", { name: "Add a dependency" }).click();
    await section.getByRole("combobox").fill("program");
    await expect(section.getByRole("option")).toHaveText([
      "Plan the launch program",
    ]);
    await section.getByRole("combobox").press("Escape");
    await expect(section.getByRole("combobox")).toHaveCount(0);
    expect(
      await page.evaluate(() => document.body.dataset.escaped),
    ).toBeUndefined();
    // Keyboard focus shows the row's remove action.
    await section
      .getByRole("button", { name: "Book the venue", exact: true })
      .focus();
    await page.keyboard.press("Tab");
    await expect(
      section.getByRole("button", {
        name: "Remove dependency: Book the venue",
      }),
    ).toBeFocused();
    await expect(
      section.getByRole("button", {
        name: "Remove dependency: Book the venue",
      }),
    ).toHaveCSS("opacity", "1");
    await section
      .getByRole("button", { name: "Book the venue", exact: true })
      .click();
    await page.waitForURL("https://app.todoist.com/app/task/venue");
    // Native pages never settle dependencies.
    expect(await writes(worker, "/tasks:resolveDependencies")).toEqual([]);
  } finally {
    await context.close();
  }
});
