import { expect, test, type Page, type Worker } from "@playwright/test";
import { controlWrites, launchPlanner } from "./planner-setup";

type BetsState = {
  bets: Record<string, unknown>[];
  review: Record<string, unknown>;
  calls: { path: string; method: string; body: Record<string, unknown> }[];
};
const WORK = "Synthetic work line";
const LAST_PERSONAL = "Synthetic quiet weekend";

/** This week's Work Bet and last week's Personal one, as Todofy keeps them. */
async function seed(worker: Worker, review: Record<string, unknown> = {}) {
  await worker.evaluate(
    ({ work, lastPersonal, review }) => {
      const state = (globalThis as unknown as { plannerState: BetsState })
        .plannerState;
      state.bets = [
        {
          week_start: "2026-10-05",
          area: "personal",
          text: lastPersonal,
          etag: "1",
        },
        { week_start: "2026-10-12", area: "work", text: work, etag: "2" },
      ];
      state.review = review;
    },
    { work: WORK, lastPersonal: LAST_PERSONAL, review },
  );
}
async function betWrites(worker: Worker) {
  return worker.evaluate(() =>
    (
      globalThis as unknown as { plannerState: BetsState }
    ).plannerState.calls.filter((call) => call.path.includes("weeklyBets")),
  );
}
/** Keys that reached Todoist's own document, where its shortcuts listen. */
async function listenOnTodoist(page: Page) {
  await page.evaluate(() => {
    const keys: string[] = [];
    Object.assign(window, { todoistKeys: keys });
    document.addEventListener("keydown", (event) => keys.push(event.key));
  });
  return () =>
    page.evaluate(
      () => (window as unknown as { todoistKeys: string[] }).todoistKeys,
    );
}

test("a Bet is edited in place: Enter saves once, Esc restores, and no key reaches Todoist", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await seed(worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    const goals = page.getByRole("region", { name: "Weekly goals" });
    const text = goals.getByRole("button", { name: `Edit work goal: ${WORK}` });
    await expect(text).toBeVisible();
    const keys = await listenOnTodoist(page);
    // The input takes the text's place at its size, and the hint the end of the heading's line,
    // so neither the panel nor the board below it moves.
    const at = await text.boundingBox();
    const panel = await goals.boundingBox();
    await text.click();
    const input = goals.getByRole("textbox", { name: "This week's work goal" });
    await expect(input).toBeFocused();
    const field = await input.boundingBox();
    expect(Math.abs(field!.y - at!.y)).toBeLessThanOrEqual(1);
    expect(Math.abs(field!.height - at!.height)).toBeLessThanOrEqual(1);
    await expect(
      goals.getByText("Enter to save · Esc to cancel"),
    ).toBeVisible();
    expect((await goals.boundingBox())!.height).toBe(panel!.height);
    await page.keyboard.type(" for q review");
    await page.keyboard.press("Enter");
    const saved = goals.getByRole("button", {
      name: `Edit work goal: ${WORK} for q review`,
    });
    await expect(saved).toBeFocused();
    expect(await betWrites(worker)).toEqual([
      {
        path: "/api/plus/v1/weeklyBets:setWeeklyBet",
        method: "POST",
        body: {
          week_start: "2026-10-12",
          area: "work",
          text: `${WORK} for q review`,
          etag: "2",
        },
      },
    ]);
    // Esc restores the saved line and its focus, with no write.
    await page.keyboard.press("Enter");
    await expect(input).toBeFocused();
    await page.keyboard.type(" and more");
    await page.keyboard.press("Escape");
    await expect(saved).toBeFocused();
    expect(await betWrites(worker)).toHaveLength(1);
    // The focus ring stays inside the line, clear of the column heading above it.
    const heading = await goals
      .getByRole("heading", { name: "Work" })
      .boundingBox();
    const ring = await saved.evaluate((button) => {
      const style = getComputedStyle(button);
      return { offset: style.outlineOffset, width: style.outlineWidth };
    });
    expect(ring).toEqual({ offset: "-1px", width: "2px" });
    expect(heading!.y + heading!.height).toBeLessThanOrEqual(
      (await saved.boundingBox())!.y,
    );
    // Typing never triggered Todoist's own shortcuts (q adds a task there).
    expect(await keys()).toEqual([]);
  } finally {
    await context.close();
  }
});

test("moving focus elsewhere in the page saves a changed Bet, and an emptied one is restored", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await seed(worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    const goals = page.getByRole("region", { name: "Weekly goals" });
    await goals
      .getByRole("button", { name: `Edit work goal: ${WORK}` })
      .click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
    // Leaving it empty never clears it.
    await page.getByRole("heading", { name: "Plan", exact: true }).click();
    await expect(
      goals.getByRole("button", { name: `Edit work goal: ${WORK}` }),
    ).toBeVisible();
    expect(await betWrites(worker)).toEqual([]);
    await goals
      .getByRole("button", { name: `Edit work goal: ${WORK}` })
      .click();
    await page.keyboard.type(", saved by Tab");
    await page.keyboard.press("Tab");
    await expect(
      goals.getByRole("button", {
        name: `Edit work goal: ${WORK}, saved by Tab`,
      }),
    ).toBeVisible();
    // Focus went on with Tab, to the Personal line, and stays there.
    await expect(
      goals.getByRole("button", { name: "Write this week's personal goal" }),
    ).toBeFocused();
    expect(await betWrites(worker)).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("an empty Bet shows last week's, and Keep (shown on hover or focus) writes it", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await seed(worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    const goals = page.getByRole("region", { name: "Weekly goals" });
    const previous = goals.getByText(`Last week: ${LAST_PERSONAL}`);
    await expect(previous).toBeVisible();
    const keep = goals.getByRole("button", {
      name: `Keep last week's personal goal: ${LAST_PERSONAL}`,
    });
    const opacity = () =>
      keep.evaluate((button) => getComputedStyle(button).opacity);
    await page.mouse.move(5, 5);
    expect(await opacity()).toBe("0");
    await previous.hover();
    expect(await opacity()).toBe("1");
    await page.mouse.move(5, 5);
    // While another write waits, Keep is only marked unavailable and stays hidden at rest.
    await controlWrites(worker, { hold: true });
    await goals
      .getByRole("button", { name: `Edit work goal: ${WORK}` })
      .click();
    await page.keyboard.type(" (held)");
    await page.keyboard.press("Enter");
    await expect(keep).toHaveAttribute("aria-disabled", "true");
    expect(await opacity()).toBe("0");
    await controlWrites(worker, { hold: false, release: true });
    await expect(keep).not.toHaveAttribute("aria-disabled");
    // Keyboard: Tab from the Personal line reaches Keep, which shows once focus is in the column.
    await goals
      .getByRole("button", { name: "Write this week's personal goal" })
      .focus();
    expect(await opacity()).toBe("1");
    await page.keyboard.press("Tab");
    await expect(keep).toBeFocused();
    await page.keyboard.press("Enter");
    const kept = goals.getByRole("button", {
      name: `Edit personal goal: ${LAST_PERSONAL}`,
    });
    await expect(kept).toBeFocused();
    await expect(previous).toHaveCount(0);
    expect((await betWrites(worker)).map((call) => call.body)).toEqual([
      {
        week_start: "2026-10-12",
        area: "work",
        text: `${WORK} (held)`,
        etag: "2",
      },
      {
        week_start: "2026-10-12",
        area: "personal",
        text: LAST_PERSONAL,
      },
    ]);
  } finally {
    await context.close();
  }
});

test("a Bet changed in another tab keeps the draft; Esc shows the latest", async () => {
  const { context, worker } = await launchPlanner();
  try {
    await seed(worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    const goals = page.getByRole("region", { name: "Weekly goals" });
    await goals
      .getByRole("button", { name: `Edit work goal: ${WORK}` })
      .click();
    await worker.evaluate(() => {
      const state = (globalThis as unknown as { plannerState: BetsState })
        .plannerState;
      const work = state.bets.find((bet) => bet.area === "work")!;
      Object.assign(work, { text: "Synthetic other tab", etag: "3" });
    });
    await page.keyboard.type(" (mine)");
    await page.keyboard.press("Enter");
    await expect(goals.getByRole("alert")).toHaveText(
      "This goal was changed elsewhere. Press Enter again to replace it with your text, or Esc to see the latest.",
    );
    await expect(
      goals.getByRole("textbox", { name: "This week's work goal" }),
    ).toHaveValue(`${WORK} (mine)`);
    await page.keyboard.press("Escape");
    await expect(
      goals.getByRole("button", {
        name: "Edit work goal: Synthetic other tab",
      }),
    ).toBeFocused();
  } finally {
    await context.close();
  }
});

test("Sunday's weekly review writes next week's Bets, apart from the commitments", async () => {
  const { context, worker } = await launchPlanner();
  try {
    // The account's Sunday, the last day of the week of 2026-10-12.
    await seed(worker, { today: "2026-10-18" });
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today?todoist-plus=review");
    const review = page.getByRole("region", { name: "Weekly review" });
    const goals = review.getByRole("list", { name: "Next week's goals" });
    await goals
      .getByRole("button", { name: "Write next week's personal goal" })
      .click();
    const input = goals.getByRole("textbox", {
      name: "Next week's personal goal",
    });
    await expect(input).toBeFocused();
    await page.keyboard.type("Synthetic next week");
    await page.keyboard.press("Enter");
    await expect(
      goals.getByRole("button", {
        name: "Edit next week's personal goal: Synthetic next week",
      }),
    ).toBeFocused();
    await expect(review.getByRole("status")).toHaveText(
      "Next week's personal goal saved",
    );
    expect((await betWrites(worker)).map((call) => call.body)).toEqual([
      {
        week_start: "2026-10-19",
        area: "personal",
        text: "Synthetic next week",
      },
    ]);
    // This week's line in Plan is unchanged.
    await expect(
      page
        .getByRole("region", { name: "Weekly goals" })
        .getByRole("button", { name: "Write this week's personal goal" }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});
