import { expect, test, type Page } from "@playwright/test";
import { createTask, seedMail, stubPlanning } from "./planning-stub";

// Chrome hands a launch to an open window (manifest `launch_handler: focus-existing`) only in an installed app
// window, which headless Playwright cannot install. So `window.launchQueue` is stubbed: the page's consumer is
// kept and each test calls it as Chrome would, with the launch's `targetURL`.
test.use({ serviceWorkers: "block" });
const ORIGIN = "http://127.0.0.1:8798";

declare global {
  interface Window {
    launch?: (params: { targetURL: string }) => void;
    marker?: string;
  }
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "launchQueue", {
      configurable: true,
      value: {
        setConsumer(consumer: (params: { targetURL: string }) => void) {
          window.launch = consumer;
        },
      },
    });
  });
});

/** Opens a page as a fresh app window would: Chrome first queues the launch that loaded it. */
async function open(page: Page, path: string, heading: string) {
  await page.goto(path);
  await expect(
    page.getByRole("heading", { name: heading, exact: true }),
  ).toBeVisible();
  await page.waitForFunction(() => window.launch);
  // This document's own launch, by the URL it loaded: the load path already handled it.
  await page.evaluate((targetURL) => {
    window.launch!({ targetURL });
    // A reload would drop this, so its survival shows each launch acted in the same document.
    window.marker = "same document";
  }, new URL(path, ORIGIN).href);
}
async function launch(page: Page, path: string) {
  await page.evaluate(
    (targetURL) => window.launch!({ targetURL }),
    new URL(path, page.url()).href,
  );
}
async function sameDocument(page: Page) {
  expect(await page.evaluate(() => window.marker)).toBe("same document");
}

test("a task link opens that task over the current page, without a reload", async ({
  page,
  request,
}) => {
  const task = await createTask(request, {
    title: `Synthetic launched task ${crypto.randomUUID()}`,
  });
  await open(page, "/#/today", "Today");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await launch(page, `/?task=${task.name.split("/")[1]}`);
  const details = page.getByRole("dialog", { name: "Task details" });
  await expect(
    details.getByRole("textbox", { name: "Task name", exact: true }),
  ).toHaveValue(task.title);
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeAttached();
  // As a link loaded here: the parameter stays while the dialog is open, then goes.
  expect(new URL(page.url()).searchParams.get("task")).toBe(
    task.name.split("/")[1],
  );
  await details
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  expect(new URL(page.url()).searchParams.has("task")).toBe(false);
  await sameDocument(page);
});

test("the Dock's routes and Quick add act in the open window", async ({
  page,
}) => {
  await open(page, "/#/upcoming", "Upcoming");
  await launch(page, "/#/focus");
  await expect(
    page.getByRole("heading", { name: "Focus", exact: true }),
  ).toBeVisible();
  await launch(page, "/#/today");
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
  // Quick add has no page context: Inbox and no date, even over Today.
  await launch(page, "/?add=1");
  const dialog = page.getByRole("dialog", { name: "Add task", exact: true });
  await expect(
    dialog.getByRole("combobox", { name: "Project", exact: true }),
  ).toHaveText("Inbox");
  await expect(
    dialog.getByRole("button", { name: "Date", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeAttached();
  // Quick add while Add task is open only shows it.
  await launch(page, "/?add=1");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // The same URL again opens it again.
  await launch(page, "/?add=1");
  await expect(dialog).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
  await sameDocument(page);
});

test("a review link opens Plan's checklist each time, also after it was closed", async ({
  page,
}) => {
  const state = await stubPlanning(page, {
    tasks: [
      {
        id: "launch-review",
        title: "Synthetic launch review",
        area: "work",
        stage: "committed",
      },
    ],
  });
  await page.clock.setFixedTime(new Date(`${state.today}T18:00:00Z`));
  await open(page, "/#/focus", "Focus");
  const review = page.getByRole("region", { name: "Weekly review" });
  await launch(page, "/?review=1#/plan");
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: "Close", exact: true }).click();
  await expect(review).toHaveCount(0);
  // Into Plan as it is shown, with no route of its own.
  await launch(page, "/?review=1");
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: "Close", exact: true }).click();
  // A later visit to Plan does not reopen it.
  await page.getByRole("link", { name: "Today", exact: true }).click();
  await page.getByRole("link", { name: "Plan", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Weekly goals" }),
  ).toBeVisible();
  await expect(review).toHaveCount(0);
  await sameDocument(page);
});

test("a launch waits for an open task dialog, so its draft is kept", async ({
  page,
  request,
}) => {
  const editing = await createTask(request, {
    title: `Synthetic draft task ${crypto.randomUUID()}`,
  });
  const launched = await createTask(request, {
    title: `Synthetic waiting task ${crypto.randomUUID()}`,
  });
  await open(page, "/#/inbox", "Inbox");
  await launch(page, `/?task=${editing.name.split("/")[1]}`);
  const details = page.getByRole("dialog", { name: "Task details" });
  const name = details.getByRole("textbox", { name: "Task name", exact: true });
  await expect(name).toHaveValue(editing.title);
  // The task already open: nothing happens.
  await launch(page, `/?task=${editing.name.split("/")[1]}`);
  await name.fill("Synthetic unsaved draft");
  await launch(page, `/?add=1`);
  await launch(page, `/?task=${launched.name.split("/")[1]}#/today`);
  // The route changes at once; the task waits, and only the newest launch does.
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeAttached();
  await expect(name).toHaveValue("Synthetic unsaved draft");
  await details
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(name).toHaveValue(launched.title);
  expect(new URL(page.url()).searchParams.get("task")).toBe(
    launched.name.split("/")[1],
  );
  await details
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await sameDocument(page);
});

test("a mail summary link opens the summary in Mail, also when Mail is shown", async ({
  page,
}) => {
  const id = crypto.randomUUID();
  await seedMail([
    {
      id,
      title: "Synthetic linked mail",
      summary: `Synthetic summary of ${id}`,
      pending: false,
    },
  ]);
  await open(page, "/#/today", "Today");
  const summary = page.getByRole("dialog", {
    name: "Mail summary",
    exact: true,
  });
  for (let time = 0; time < 2; time++) {
    await launch(page, `/?mail=${id}#/mail`);
    await expect(summary).toContainText(`Synthetic summary of ${id}`);
    await summary.getByRole("button", { name: "Close", exact: true }).click();
    await expect(summary).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has("mail")).toBe(false);
    expect(new URL(page.url()).hash).toBe("#/mail");
  }
  await sameDocument(page);
});

test("a Quick add link opens Add task once on load; a reload does not", async ({
  page,
}) => {
  await open(page, "/?add=1", "Today");
  const dialog = page.getByRole("dialog", { name: "Add task", exact: true });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Date", exact: true }),
  ).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
  // The launch that loaded this window was skipped above: one dialog, not a second one after closing.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Today", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
