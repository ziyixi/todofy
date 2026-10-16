import {
  expect,
  test,
  type Locator,
  type Page,
  type Worker,
} from "@playwright/test";
import {
  addDeadlineTasks,
  controlWrites,
  dragPlanner,
  launchPlanner,
} from "./planner-setup";

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
const lane = (page: Page, name: string) =>
  page.getByRole("region", { name, exact: true });
/** A lane's card titles, in order. */
const titles = (page: Page, name: string) =>
  lane(page, name).locator(".planning-outcome-title");
/** The board's status region, beside the lanes; dnd-kit adds another for drags. */
const announced = (page: Page) =>
  page.locator('.review-board > [role="status"]');
const card = (page: Page, title: string) =>
  page.locator(".review-draggable", {
    has: page.getByRole("button", { name: new RegExp(`^${title},`, "u") }),
  });

test("Start now and Waiting lead the four stage lanes with the same cards, and Start marks a task in progress", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await addDeadlineTasks(worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    await expect(page.locator(".review-lane")).toHaveCount(6);
    expect(
      await page
        .locator(".review-lane")
        .evaluateAll((lanes) =>
          lanes.map((item) => item.getAttribute("aria-label")),
        ),
    ).toEqual([
      "Start now",
      "Waiting",
      "Quarter",
      "Month",
      "Week",
      "Committed",
    ]);
    // One row of lanes at this width, all of the same width.
    const boxes = await page
      .locator(".review-lane")
      .evaluateAll((lanes) =>
        lanes.map((item) => item.getBoundingClientRect().toJSON()),
      );
    for (const box of boxes) {
      expect(Math.abs(box.top - boxes[0]!.top)).toBeLessThan(1);
      expect(Math.abs(box.width - boxes[0]!.width)).toBeLessThan(1);
    }
    await expect(titles(page, "Start now")).toHaveText([
      "Quarterly report draft",
      "Submit the expense claim",
    ]);
    await expect(
      lane(page, "Start now").locator(".planning-outcome-status"),
    ).toHaveText(["2 days past", "Deadline tomorrow"]);
    await expect(titles(page, "Committed")).toHaveText([
      "Synthetic weekly outcome",
      "Prepare the visa documents",
    ]);
    await expect(
      card(page, "Prepare the visa documents").locator(
        ".planning-outcome-status",
      ),
    ).toHaveText("5 days left");
    await expect(titles(page, "Waiting")).toHaveText([
      "Contract signature",
      "Quote reply",
    ]);
    // The untouched age follows the real clock; the deadline follows the plan's today.
    await expect(
      lane(page, "Waiting").locator(".planning-outcome-status"),
    ).toHaveText([
      /^Untouched \d+ days · Deadline Oct 20$/u,
      /^Untouched \d+ days$/u,
    ]);
    // Cards never widen their lane, also with the longest English status: it wraps between its
    // parts instead.
    expect(
      await page
        .locator(".review-lane")
        .evaluateAll((lanes) =>
          lanes.flatMap((item) =>
            [...item.querySelectorAll(".planning-outcome-card")].filter(
              (card) =>
                card.getBoundingClientRect().right >
                item.getBoundingClientRect().right + 0.5,
            ),
          ),
        ),
    ).toHaveLength(0);
    // The same card everywhere: Start now's cards look like Committed's.
    const look = (locator: Locator) =>
      locator.evaluate((element) => {
        const style = getComputedStyle(element);
        return [
          style.borderRadius,
          style.backgroundColor,
          style.boxShadow,
          style.minHeight,
          style.paddingLeft,
          Math.round(element.getBoundingClientRect().width),
        ];
      });
    expect(
      await look(
        card(page, "Submit the expense claim").locator(
          ".planning-outcome-card",
        ),
      ),
    ).toEqual(
      await look(
        card(page, "Synthetic weekly outcome").locator(
          ".planning-outcome-card",
        ),
      ),
    );
    // The one colour is the days past.
    expect(
      await page
        .locator(".review-board .planning-danger-text")
        .evaluateAll((elements) =>
          elements.map((element) => element.textContent),
        ),
    ).toEqual(["2 days past"]);
    // Nothing is stacked under the board.
    await expect(page.locator(".planning-view details")).toHaveCount(0);
    // Start is hidden at rest, shows on hover without moving the title or the status, and is
    // reached by Tab from the card.
    const claim = card(page, "Submit the expense claim");
    const start = claim.getByRole("button", {
      name: "Start: Submit the expense claim",
    });
    await page.mouse.move(0, 0);
    expect(await opacity(start)).toBe("0");
    const at = async () =>
      [
        await claim.locator(".planning-outcome-title").boundingBox(),
        await claim.locator(".planning-outcome-status").boundingBox(),
      ].map((box) => box && [box.x, box.y, box.width, box.height]);
    const before = await at();
    await claim.hover();
    expect(await opacity(start)).toBe("1");
    expect(await at()).toEqual(before);
    await page.mouse.move(0, 0);
    await claim.locator(".planning-outcome-card").focus();
    await page.keyboard.press("Tab");
    await expect(start).toBeFocused();
    expect(await opacity(start)).toBe("1");

    const read = await reads(worker);
    await page.keyboard.press("Enter");
    await expect(announced(page)).toHaveText(
      "Marked in progress: Submit the expense claim",
    );
    // In progress and without a stage, it leaves the board.
    await expect(titles(page, "Start now")).toHaveText([
      "Quarterly report draft",
    ]);
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
    // The confirmed task is merged; nothing is read again. Focus moves to the next Start.
    expect(await reads(worker)).toBe(read);
    await expect(
      page.getByRole("button", { name: "Start: Prepare the visa documents" }),
    ).toBeFocused();

    // Week has nothing under its calendar either.
    await page.getByRole("tab", { name: "Week", exact: true }).click();
    await expect(page.locator(".planning-calendar")).toBeVisible();
    await expect(page.locator(".planning-view details")).toHaveCount(0);
    expect(
      await page.locator(".planning-week").evaluate((week) => {
        // Past the drag overlay dnd-kit keeps beside the week.
        let next = week.nextElementSibling;
        while (next?.hasAttribute("data-dnd-overlay"))
          next = next.nextElementSibling;
        return next?.className ?? "";
      }),
    ).toBe("planning-reset-note");
  } finally {
    await context.close();
  }
});

test("dragging a Start now card into Committed sets the stage and in progress in one write, shown at once", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await addDeadlineTasks(worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    await expect(titles(page, "Start now")).toHaveCount(2);
    await controlWrites(worker, { hold: true });
    const draft = card(page, "Quarterly report draft");
    await dragPlanner(
      page,
      draft.locator(".review-drag-handle"),
      lane(page, "Committed"),
    );
    // Shown at once in Committed, waiting there; Start now keeps the other card.
    const moved = lane(page, "Committed").locator(".review-draggable", {
      hasText: "Quarterly report draft",
    });
    await expect(moved).toHaveAttribute("aria-busy", "true");
    await expect(titles(page, "Start now")).toHaveText([
      "Submit the expense claim",
    ]);
    // In progress, it no longer says it should start.
    await expect(moved.locator(".planning-outcome-status")).toHaveCount(0);
    expect(await writes(worker)).toEqual([
      {
        path: "/api/plus/v1/tasks:setTaskPlan",
        method: "POST",
        body: {
          task_id: "draft",
          etag: "draft-1",
          request_id: expect.any(String),
          stage: "committed",
          active: true,
        },
      },
    ]);
    await controlWrites(worker, { hold: false, release: true });
    await expect(moved).not.toHaveAttribute("aria-busy", "true");
    await expect(titles(page, "Committed")).toHaveText([
      "Synthetic weekly outcome",
      "Quarterly report draft",
      "Prepare the visa documents",
    ]);
  } finally {
    await context.close();
  }
});

test("dragging a Waiting card into Week sets only its stage; Start now and Waiting take no drops", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await addDeadlineTasks(worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    await expect(titles(page, "Waiting")).toHaveCount(2);
    await dragPlanner(
      page,
      card(page, "Contract signature").locator(".review-drag-handle"),
      lane(page, "Week"),
    );
    await expect(titles(page, "Week")).toContainText(["Contract signature"]);
    await expect(titles(page, "Waiting")).toHaveText(["Quote reply"]);
    // In its stage lane, the card still says it waits.
    await expect(
      card(page, "Contract signature").locator(".planning-outcome-status"),
    ).toHaveText(/^Untouched \d+ days · Deadline Oct 20$/u);
    await expect
      .poll(async () => (await writes(worker)).map((call) => call.body))
      .toEqual([
        {
          task_id: "contract",
          etag: "contract-1",
          request_id: expect.any(String),
          stage: "weekly",
        },
      ]);
    // A drop on Start now or Waiting changes nothing.
    for (const name of ["Waiting", "Start now"]) {
      await dragPlanner(
        page,
        card(page, "Prepare the visa documents").locator(".review-drag-handle"),
        lane(page, name),
      );
      await expect(titles(page, "Committed")).toContainText([
        "Prepare the visa documents",
      ]);
    }
    expect(await writes(worker)).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("Focus's quiet line opens Review with Start now focused", async () => {
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
    await expect(lane(page, "Start now")).toBeFocused();
    await expect(
      page.getByRole("tab", { name: "Review", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    expect(await writes(worker)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("the weekly review lists a deadline without a lead and sets it with the editor's control", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await addDeadlineTasks(worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today?todoist-plus=review");
    const review = page.getByRole("region", { name: "Weekly review" });
    const missing = review.locator("li", {
      has: page.getByRole("checkbox", {
        name: "Reviewed: 1 deadline has no start-ahead set",
      }),
    });
    await missing.getByRole("button", { name: "Show" }).click();
    const select = missing.getByRole("combobox", {
      name: "Start ahead: Renew the car insurance",
    });
    await expect(missing.getByRole("listitem")).toContainText(
      "Deadline Nov 30",
    );
    await select.selectOption("14");
    await expect(review.getByRole("status")).toHaveText(
      "Start ahead set: Renew the car insurance",
    );
    // The line is gone once every deadline has a lead; focus returns to the heading.
    await expect(missing).toHaveCount(0);
    await expect(
      review.getByRole("heading", { name: "Weekly review" }),
    ).toBeFocused();
    expect(await writes(worker)).toEqual([
      {
        path: "/api/plus/v1/tasks:setTaskLead",
        method: "POST",
        body: {
          task_id: "insurance",
          etag: "insurance-1",
          request_id: expect.any(String),
          deadline: "2026-11-30",
          lead_days: 14,
        },
      },
    ]);
  } finally {
    await context.close();
  }
});

test("narrow lanes stack, and cards keep their title, area and status without overflowing", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await addDeadlineTasks(worker);
    const page = await context.newPage();
    // Under the 650px breakpoint, as in a narrow window.
    await page.setViewportSize({ width: 640, height: 900 });
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    const board = page.locator(".review-board");
    await expect(lane(page, "Start now")).toBeVisible();
    const start = (await lane(page, "Start now").boundingBox())!;
    const quarter = (await lane(page, "Quarter").boundingBox())!;
    expect(quarter.y).toBeGreaterThan(start.y + start.height - 1);
    const claim = card(page, "Submit the expense claim");
    await expect(claim.locator(".planning-outcome-status")).toBeVisible();
    expect(
      await board.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  } finally {
    await context.close();
  }
});
