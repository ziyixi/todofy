import {
  expect,
  test,
  type Locator,
  type Page,
  type Worker,
} from "@playwright/test";
import {
  addCommitments,
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
  page.locator('.review-board > .plus-sr-only[role="status"]');
const card = (page: Page, title: string) =>
  page.locator(".review-draggable", {
    has: page.getByRole("button", { name: new RegExp(`^${title},`, "u") }),
  });
/**
 * How a card's two-part status is laid out: its lines, whether each part's words start at the
 * area's left edge, and whether the separator lies in the clipped margin left of that edge.
 */
const statusLines = (outcome: Locator) =>
  outcome.evaluate((element) => {
    const status = element.querySelector(".planning-outcome-status")!;
    const edge = element
      .querySelector(".planning-outcome-context")!
      .getBoundingClientRect().left;
    const words = [...status.children].map((part) => {
      const range = document.createRange();
      range.selectNodeContents(
        [...part.childNodes].find((node) => node.nodeType === Node.TEXT_NODE)!,
      );
      return range.getBoundingClientRect();
    });
    const separator = status
      .querySelector(".planning-outcome-separator")!
      .getBoundingClientRect();
    return {
      lines: new Set(words.map((box) => Math.round(box.top))).size,
      sameEdge:
        Math.abs(words[0]!.left - edge) < 0.5 &&
        (words[1]!.top === words[0]!.top ||
          Math.abs(words[1]!.left - edge) < 0.5),
      separatorHidden: separator.right <= edge + 0.5,
    };
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
    // Candidate lanes retain one row; Committed alone spans the row below.
    const boxes = await page
      .locator('.review-lane:not([data-lane="committed"])')
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
    ).toHaveText(["2 days late", "Deadline tomorrow"]);
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
      /^No change in \d+ days · Deadline Oct 20$/u,
      /^No change in \d+ days$/u,
    ]);
    // A two-part status has its own row under the area. Here it wraps once, between its parts:
    // both lines start at the area's edge, and the separator before the second part lies in the
    // clipped margin left of it, so no line starts or ends with "·".
    expect(
      await statusLines(
        card(page, "Contract signature").locator(".planning-outcome-card"),
      ),
    ).toEqual({ lines: 2, sameEdge: true, separatorHidden: true });
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
          style.paddingRight,
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
    // The hover action must not shrink its own title, even though the regions have different widths.
    const titleWidth = () =>
      card(page, "Submit the expense claim")
        .locator(".planning-outcome-title")
        .evaluate((element) => element.getBoundingClientRect().width);
    const beforeHover = await titleWidth();
    await card(page, "Submit the expense claim").hover();
    expect(await titleWidth()).toBeCloseTo(beforeHover, 0);
    // The one colour is the days past.
    expect(
      await page
        .locator(".review-board .planning-danger-text")
        .evaluateAll((elements) =>
          elements.map((element) => element.textContent),
        ),
    ).toEqual(["2 days late"]);
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
    await expect(
      claim.getByRole("button", {
        name: "Complete task: Submit the expense claim",
        exact: true,
      }),
    ).toBeFocused();
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
    // The floating card is the card it carries, at its size.
    const source = (await draft.boundingBox())!;
    const handle = (await draft.locator(".review-drag-handle").boundingBox())!;
    await page.mouse.move(
      handle.x + handle.width / 2,
      handle.y + handle.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      handle.x + handle.width / 2 + 8,
      handle.y + handle.height / 2,
      {
        steps: 3,
      },
    );
    const preview = page.locator("[data-dnd-overlay] .review-drag-preview");
    await expect(preview).toBeVisible();
    const floating = (await preview.boundingBox())!;
    expect([floating.width, floating.height]).toEqual([
      source.width,
      source.height,
    ]);
    const committed = (await lane(page, "Committed").boundingBox())!;
    await page.mouse.move(
      committed.x + committed.width / 2,
      committed.y + committed.height / 2,
      { steps: 18 },
    );
    await page.mouse.up();
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
    ).toHaveText(/^No change in \d+ days · Deadline Oct 20$/u);
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

test("a waiting card's two-part status fits one line in Chinese at this width", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await addDeadlineTasks(worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    await page.evaluate(() => (document.documentElement.lang = "zh"));
    const contract = card(page, "Contract signature");
    await expect(contract.locator(".planning-outcome-status")).toHaveText(
      /^\d+ 天未变动 · 10月20日截止$/u,
    );
    expect(
      await statusLines(contract.locator(".planning-outcome-card")),
    ).toEqual({
      lines: 1,
      sameEdge: true,
      separatorHidden: false,
    });
  } finally {
    await context.close();
  }
});

test("medium desktop keeps the existing candidate columns together and Committed alone below", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await addDeadlineTasks(worker);
    const page = await context.newPage();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    await expect(lane(page, "Start now")).toBeVisible();
    const columns = await page
      .locator('.review-lane:not([data-lane="committed"])')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getBoundingClientRect().toJSON()),
      );
    expect(columns).toHaveLength(5);
    for (const [index, column] of columns.entries()) {
      expect(column.y).toBeCloseTo(columns[0]!.y, 0);
      expect(column.width).toBeCloseTo(columns[0]!.width, 0);
      if (index) expect(column.x).toBeGreaterThan(columns[index - 1]!.x);
    }
    const committed = (await lane(page, "Committed").boundingBox())!;
    const board = (await page.locator(".review-lanes").boundingBox())!;
    expect(committed.x).toBeCloseTo(board.x, 0);
    expect(committed.width).toBeCloseTo(board.width, 0);
    expect(committed.y).toBeGreaterThan(
      Math.max(...columns.map((column) => column.y + column.height)),
    );
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

/** The account's `parked` label, and a synthetic task set aside with it unless `empty`. */
async function addParked(worker: Worker, empty = false) {
  await worker.evaluate((empty) => {
    const state = (
      globalThis as unknown as {
        plannerState: {
          tasks: Record<string, unknown>[];
          extraLabels: { id: string; label: string }[];
        };
      }
    ).plannerState;
    state.extraLabels.push({ id: "synthetic-parked", label: "parked" });
    if (!empty)
      state.tasks.push({
        id: "idea",
        title: "Synthetic parked idea",
        area: "work",
        stage: "none",
        labels: ["parked"],
        etag: "idea-1",
        update_time: "2026-09-01T09:00:00Z",
      });
  }, empty);
}
/** Each lane's name and box, left to right. */
const laneBoxes = (page: Page) =>
  page.locator(".review-lane").evaluateAll((lanes) =>
    lanes.map((element) => {
      const { x, y, width } = element.getBoundingClientRect();
      return { name: element.getAttribute("aria-label"), x, y, width };
    }),
  );

test("Parked sits between Waiting and the stages; a drag in sets a card aside, one out takes a stage", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await addDeadlineTasks(worker);
    await addParked(worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    await expect(titles(page, "Parked")).toHaveText(["Synthetic parked idea"]);
    expect((await laneBoxes(page)).map((box) => box.name)).toEqual([
      "Start now",
      "Waiting",
      "Parked",
      "Quarter",
      "Month",
      "Week",
      "Committed",
    ]);
    await expect(
      lane(page, "Parked").locator(".review-lane-header small"),
    ).toHaveText("@parked");
    await dragPlanner(
      page,
      card(page, "Synthetic month outcome").locator(".review-drag-handle"),
      lane(page, "Parked"),
    );
    await expect(titles(page, "Parked")).toContainText([
      "Synthetic month outcome",
    ]);
    await expect(titles(page, "Month")).toHaveCount(0);
    await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
    await dragPlanner(
      page,
      card(page, "Synthetic parked idea").locator(".review-drag-handle"),
      lane(page, "Month"),
    );
    await expect(titles(page, "Month")).toHaveText(["Synthetic parked idea"]);
    await expect
      .poll(async () => (await writes(worker)).map((call) => call.body))
      .toEqual([
        {
          task_id: "month",
          etag: "month-1",
          request_id: expect.any(String),
          parked: true,
        },
        {
          task_id: "idea",
          etag: "idea-1",
          request_id: expect.any(String),
          stage: "monthly",
          parked: false,
        },
      ]);
  } finally {
    await context.close();
  }
});

test("candidate lanes keep their desktop row, pair and stack narrowly, while Committed always has its own row", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await addDeadlineTasks(worker);
    await addParked(worker);
    const page = await context.newPage();
    const layout = async (width: number) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
      await expect(page.locator(".review-lanes")).toHaveAttribute(
        "data-lanes",
        "7",
      );
      const boxes = await laneBoxes(page);
      const rows = [...new Set(boxes.map((box) => Math.round(box.y)))];
      return boxes.map((box) => ({
        name: box.name,
        row: rows.indexOf(Math.round(box.y)),
        x: Math.round(box.x),
      }));
    };
    const rows = (boxes: Awaited<ReturnType<typeof layout>>) =>
      boxes.map((box) => box.row);
    // Committed is the only full-width lane on desktop.
    expect(rows(await layout(1854))).toEqual([0, 0, 0, 0, 0, 0, 1]);
    expect(rows(await layout(1300))).toEqual([0, 0, 0, 0, 0, 0, 1]);
    // Narrow layouts retain paired columns and then one column.
    expect(rows(await layout(1000))).toEqual([0, 0, 1, 1, 2, 2, 3]);
    expect(rows(await layout(700))).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
  } finally {
    await context.close();
  }
});

/** Every part of a card whose right edge is past the card's own, as "lane: text". */
const overflowing = (page: Page) =>
  page.locator(".planning-outcome-card").evaluateAll((cards) =>
    cards.flatMap((card) => {
      const edge = card.getBoundingClientRect().right;
      return [...card.querySelectorAll("span, strong")]
        .filter((part) => part.getBoundingClientRect().right > edge + 0.5)
        .map(
          (part) =>
            `${card.closest("[data-lane]")?.getAttribute("data-lane")}: ${part.textContent}`,
        );
    }),
  );

test("candidate columns and the Committed row keep every card's text inside, in English and Chinese", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await addDeadlineTasks(worker);
    await addCommitments(worker);
    await addParked(worker);
    // Eleven more steps under the weekly outcome: two-digit counts.
    await worker.evaluate(() => {
      const state = (
        globalThis as unknown as {
          plannerState: { tasks: Record<string, unknown>[] };
        }
      ).plannerState;
      for (let index = 0; index < 11; index++)
        state.tasks.push({
          id: `extra-${index}`,
          title: `Synthetic extra step ${index}`,
          parent_id: "parent",
          area: "unassigned",
          stage: "none",
          etag: `extra-${index}-1`,
        });
    });
    const page = await context.newPage();
    // The owner's window: every lane about 205px wide.
    await page.setViewportSize({ width: 1854, height: 900 });
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    await expect(page.locator(".review-lanes")).toHaveAttribute(
      "data-lanes",
      "7",
    );
    const rows = new Set(
      (await laneBoxes(page)).map((box) => Math.round(box.y)),
    );
    expect(rows.size).toBe(2);
    await expect(page.locator(".planning-outcome-counts")).not.toHaveCount(0);
    expect(await overflowing(page)).toEqual([]);
    await page.evaluate(() => (document.documentElement.lang = "zh-CN"));
    await expect(lane(page, "搁置")).toBeVisible();
    await expect(
      page.locator(".planning-outcome-counts", { hasText: /^1\d 个步骤/u }),
    ).not.toHaveCount(0);
    expect(await overflowing(page)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("an empty Parked lane is in place before a drag starts, so the board never moves under it", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await addDeadlineTasks(worker);
    await addParked(worker, true);
    const page = await context.newPage();
    await page.setViewportSize({ width: 1300, height: 900 });
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    await expect(lane(page, "Parked")).toContainText("Drop here to park");
    const before = await laneBoxes(page);
    const handle = card(page, "Synthetic quarter outcome").locator(
      ".review-drag-handle",
    );
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 40, box.y + 30, { steps: 4 });
    await expect(
      page.locator("[data-dnd-overlay][data-dnd-dragging]"),
    ).toHaveCount(1);
    expect(await laneBoxes(page)).toEqual(before);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    expect(await writes(worker)).toEqual([]);
  } finally {
    await context.close();
  }
});

test("empty Parked retains its candidate column while Committed occupies the row below", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await addParked(worker, true);
    const page = await context.newPage();
    // Without Start now and Waiting: Parked stays alongside the three candidate stages.
    for (const width of [1150, 1000]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
      await expect(page.locator(".review-lanes")).toHaveAttribute(
        "data-lanes",
        "5",
      );
      await expect(lane(page, "Parked")).toContainText("Drop here to park");
      const parked = (await lane(page, "Parked").boundingBox())!;
      const quarter = (await lane(page, "Quarter").boundingBox())!;
      expect(parked.y).toBeCloseTo(quarter.y, 0);
      expect(parked.width).toBeCloseTo(quarter.width, 0);
      expect(parked.height).toBeGreaterThan(169);
      const committed = (await lane(page, "Committed").boundingBox())!;
      expect(committed.y).toBeGreaterThan(parked.y + parked.height);
    }
    // In one row with the stages it is a lane like theirs.
    await page.setViewportSize({ width: 1854, height: 900 });
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    await expect(lane(page, "Parked")).toContainText("Drop here to park");
    expect((await lane(page, "Parked").boundingBox())!.height).toBeGreaterThan(
      169,
    );
  } finally {
    await context.close();
  }
});
