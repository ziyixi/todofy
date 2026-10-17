import { expect, test, type Page, type Worker } from "@playwright/test";
import {
  addDependencyTasks,
  controlWrites,
  launchPlanner,
} from "./planner-setup";

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
    // The pending row and the saved one have the same height: confirming moves nothing.
    await controlWrites(worker, { hold: true });
    await section.getByRole("combobox").press("Enter");
    const row = section.locator(".plus-dependency");
    await expect(row).toHaveClass(/is-pending/u);
    const pending = (await row.boundingBox())!.height;
    await controlWrites(worker, { hold: false, release: true });
    await expect(
      section.getByRole("button", { name: "Book the venue", exact: true }),
    ).toBeVisible();
    expect((await row.boundingBox())!.height).toBe(pending);
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
    const title = section.getByRole("button", {
      name: "Book the venue",
      exact: true,
    });
    await expect(title).toHaveCSS("text-decoration-line", "none");
    await section.locator(".plus-dependency").hover();
    await expect(remove).toHaveCSS("opacity", "1");
    expect(
      await remove.evaluate((button) => button.getBoundingClientRect().height),
    ).toBe(24);
    // The title opens that task: on hover it says so with an underline.
    await title.hover();
    await expect(title).toHaveCSS("text-decoration-line", "underline");
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
    // The done line's remove action shows on hover or keyboard focus only, as a row's does.
    const clear = dependencies(page).getByRole("button", {
      name: "Remove the done dependencies",
    });
    await page.mouse.move(2, 2);
    await expect(clear).toHaveCSS("opacity", "0");
    await dependencies(page).locator(".plus-dependency-done").hover();
    await expect(clear).toHaveCSS("opacity", "1");
    expect(
      await clear.evaluate((button) => button.getBoundingClientRect().height),
    ).toBe(24);
    expect((await writes(worker, "/tasks:setTaskPlan")).length).toBe(0);
  } finally {
    await context.close();
  }
});

test("a recurring prerequisite waits for its next completion and can be chosen again; a deleted one is told once under the lanes", async () => {
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
    const board = page.locator(".review-lanes");
    const before = (await board.boundingBox())!;
    await page.getByRole("button", { name: "Refresh" }).click();
    const notice = page.locator(".review-board-notices");
    await expect(notice).toHaveText(
      "“Plan the launch program” no longer waits — the task it waited for was deleted.",
    );
    await expect(notice).toHaveAttribute("role", "status");
    // It comes under the lanes: nothing above them moves.
    expect((await board.boundingBox())!.y).toBe(before.y);
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
    // The weekly sync was completed since: the picker offers it again, to wait for its next completion.
    await page.getByRole("button", { name: /^Send the invitations,/u }).click();
    await section.getByRole("button", { name: "Add a dependency" }).click();
    await section.getByRole("combobox").fill("sync");
    await expect(section.getByRole("option")).toHaveText([
      "Weekly launch sync",
    ]);
    await section.getByRole("combobox").press("Enter");
    await expect(section.locator(".plus-dependency")).toHaveText([
      "Weekly launch syncAfter its next completion",
    ]);
    expect(
      await worker.evaluate(() =>
        (
          globalThis as unknown as { plannerState: DependencyState }
        ).plannerState.dependencies.filter(
          (dependency) => dependency.prerequisite_id === "weekly",
        ),
      ),
    ).toEqual([
      {
        task_id: "invite",
        prerequisite_id: "weekly",
        baseline_completed_count: 5,
      },
    ]);
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

test("a long prerequisite title ends in an ellipsis inside its marks, and its part of the status keeps one line", async () => {
  const { context, worker } = await launchPlanner();
  try {
    const long = "订场地并确认所有嘉宾的餐饮住宿与交通接送安排";
    await addDependencyTasks(worker, {
      venue: long,
      invite: "发邀请函",
      program: "年度活动方案",
      shelf: "整理书架",
      weekly: "周例会",
    });
    await worker.evaluate(() =>
      (
        globalThis as unknown as { plannerState: DependencyState }
      ).plannerState.dependencies.push({
        task_id: "invite",
        prerequisite_id: "venue",
      }),
    );
    const page = await context.newPage();
    const measure = () =>
      page.locator(".planning-outcome-card").evaluateAll((cards) =>
        cards
          .filter((card) => card.querySelector(".planning-outcome-quoted"))
          .map((card) => {
            const status = card.querySelector(".planning-outcome-status")!;
            const quoted = card.querySelector<HTMLElement>(
              ".planning-outcome-quoted",
            )!;
            const line = (element: Element) =>
              Math.round(element.getBoundingClientRect().height / 16);
            return {
              title: card.querySelector(".planning-outcome-title")!.textContent,
              inside:
                status.getBoundingClientRect().right <=
                card.getBoundingClientRect().right,
              cut: quoted.scrollWidth > quoted.clientWidth,
              quotedLines: line(quoted.parentElement!),
              // A two-part status may wrap between its parts on a narrow card, never inside them.
              wrapsInside: line(status) > status.children.length,
              tooltip: quoted.title,
            };
          }),
      );
    // Five lanes in one row (Waiting and the four stages), then four-column lanes.
    for (const [width, height] of [
      [1600, 1000],
      [1440, 900],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
      for (const language of ["zh", "en"]) {
        await page.evaluate(
          (language) => (document.documentElement.lang = language),
          language,
        );
        await expect(page.locator(".planning-outcome-quoted")).toHaveCount(3);
        // A language switch mounts the board again (its drag instructions follow the language), so
        // the measure waits for the new cards rather than reading the old ones on their way out.
        await expect.poll(measure, { message: `${width} ${language}` }).toEqual(
          [
            ["年度活动方案", long],
            ["整理书架", "发邀请函"],
            ["发邀请函", long],
          ].map(([title, prerequisite]) => ({
            title,
            inside: true,
            cut: prerequisite === long,
            quotedLines: 1,
            wrapsInside: false,
            tooltip: prerequisite,
          })),
        );
        // The full title stays in the card's accessible name.
        await expect(
          page.getByRole("button", {
            name: new RegExp(`^发邀请函,.*${long}`, "u"),
          }),
        ).toHaveCount(1);
      }
    }
  } finally {
    await context.close();
  }
});
