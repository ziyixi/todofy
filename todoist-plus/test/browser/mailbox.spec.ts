import { expect, test, type Page, type Worker } from "@playwright/test";
import { controlWrites, launchPlanner } from "./planner-setup";
import { themeCss } from "./theme";

type MailState = {
  tasks: Record<string, unknown>[];
  days: Record<string, string[]>;
  review: Record<string, unknown>;
  mail: Record<string, unknown>[];
  summaries: Record<string, string>;
  mailSettings: Record<string, unknown>;
  calls: { path: string; method: string; body: Record<string, unknown> }[];
};

/**
 * A Todoist-like page whose favourites hold a filter, Todofy's mail project and another project,
 * and whose My projects lists the mail project again.
 */
const page = `<!doctype html><html lang="en" class="theme_kale"><head><style id="todoist-theme">${themeCss}</style><style>body{margin:0;color:var(--product-library-display-primary-idle-tint);background:var(--product-library-background-base-primary);font-family:system-ui}aside{width:280px;position:fixed;inset:0 auto 0 0;background:var(--product-library-background-base-secondary)}main{margin-left:280px;min-height:100vh}#top-menu{padding:12px;list-style:none}#top-menu a{height:34px;padding:5px;display:flex;width:230px;font-size:13px;box-sizing:border-box}</style></head><body><aside data-testid="app-sidebar-scrollable-container"><ul id="top-menu"><li><a href="/app/today"><span>Today</span></a></li><li><a href="/app/upcoming"><span>Upcoming</span></a></li></ul><ul id="favorites"><li id="fav-filter"><a href="/app/filter/quick-f9">Quick</a></li><li id="fav-mail"><a href="/app/project/email-inbox-mail-project">Email Inbox</a></li><li id="fav-work"><a href="/app/project/work-work-project">Work</a></li></ul><ul id="projects"><li id="my-mail"><a href="/app/project/email-inbox-mail-project">Email Inbox</a></li></ul></aside><main id="content"><h1>Native list</h1></main></body></html>`;

/**
 * Five tasks in the mail project, today 2026-10-13 (UTC): four mail Todofy summarised, one of
 * them in a FlowDay queue and one labelled, and the owner's own task. One category is saved, and
 * the project an older build chose, which filing now ignores.
 */
async function seed(worker: Worker) {
  await worker.evaluate(() => {
    const state = (globalThis as unknown as { plannerState: MailState })
      .plannerState;
    const task = (id: string, title: string, fields = {}) => ({
      id,
      title,
      project_id: "mail-project",
      area: "unassigned",
      stage: "none",
      etag: `${id}-1`,
      ...fields,
    });
    state.tasks.push(
      task("m-bill", "Synthetic cloud bill"),
      task("m-hike", "Synthetic hike sign-up"),
      task("m-planned", "Synthetic planned mail"),
      task("m-labelled", "Synthetic labelled mail", { labels: ["context"] }),
      task("m-own", "Synthetic own task"),
    );
    state.days["2026-10-14"] = ["m-planned"];
    state.review = { inbox_project_id: "mail-project" };
    const item = (id: string, taskId: string, brief: string, at: string) => ({
      id,
      task: { provider: "todoist", external_id: taskId },
      brief,
      receive_time: at,
      has_summary: true,
    });
    state.mail = [
      item(
        "e-bill",
        "m-bill",
        "The October bill is paid automatically.",
        "2026-10-13T09:42:00Z",
      ),
      item(
        "e-hike",
        "m-hike",
        "Reply by Friday with the group size.",
        "2026-10-13T08:15:00Z",
      ),
      item(
        "e-planned",
        "m-planned",
        "A synthetic mail already planned.",
        "2026-10-12T18:20:00Z",
      ),
      item(
        "e-labelled",
        "m-labelled",
        "A synthetic mail with a label.",
        "2026-10-09T10:00:00Z",
      ),
    ];
    state.summaries = {
      "e-bill":
        "The October bill is paid automatically.\n\n**Details**\n- Amount: 128\n<img src=x onerror=alert(1)> https://example.test/bill",
    };
    state.mailSettings = {
      categories: [
        {
          id: "category-1",
          label: { provider: "todoist", external_id: "synthetic-office" },
          priority: "p2",
        },
      ],
      etag: "mail-1",
      destination: { provider: "todoist", external_id: "work-project" },
    };
  });
}
async function launchMailbox() {
  const launched = await launchPlanner();
  await launched.context.route("https://app.todoist.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: page }),
  );
  await seed(launched.worker);
  return launched;
}
/** Where a task is now in the synthetic Todoist. */
async function projectOf(worker: Worker, id: string) {
  return worker.evaluate(
    (id) =>
      (
        globalThis as unknown as { plannerState: MailState }
      ).plannerState.tasks.find((task) => task.id === id)?.project_id,
    id,
  );
}
async function calls(worker: Worker, method: string) {
  return worker.evaluate(
    (method) =>
      (
        globalThis as unknown as { plannerState: MailState }
      ).plannerState.calls.filter((call) => call.path.endsWith(method)),
    method,
  );
}
/** Keys that reached Todoist's own document, where its shortcuts listen. */
async function listenOnTodoist(tab: Page) {
  await tab.evaluate(() => {
    const keys: string[] = [];
    Object.assign(window, { todoistKeys: keys });
    document.addEventListener("keydown", (event) => keys.push(event.key));
  });
  return () =>
    tab.evaluate(
      () => (window as unknown as { todoistKeys: string[] }).todoistKeys,
    );
}

test("Mail opens the Mailbox under Plan and Focus, and the mail project's favourite hides on every page", async () => {
  const { context } = await launchMailbox();
  try {
    const tab = await context.newPage();
    await tab.goto("https://app.todoist.com/app/today");
    const nav = tab.getByRole("navigation", { name: "Todoist Plus" });
    await expect(nav.getByRole("button")).toHaveText(["Plan", "Focus", "Mail"]);
    // A native page hides the favourite too; My projects keeps the project.
    await expect(tab.locator("#fav-mail")).toBeHidden();
    await expect(tab.locator("#projects #my-mail")).toBeVisible();
    await nav.getByRole("button", { name: "Mail" }).click();
    await expect(tab).toHaveURL(/todoist-plus=mailbox/u);
    const heading = tab.getByRole("heading", { name: "Mail", level: 1 });
    await expect(heading).toBeFocused();
    // Focused for screen readers when the page opens, without a ring of the browser's own.
    expect(
      await heading.evaluate(
        (element) => getComputedStyle(element).outlineStyle,
      ),
    ).toBe("none");
    await expect(tab.getByText("4 emails")).toBeVisible();
    await expect(tab.locator("#fav-mail")).toBeHidden();
    // Another project favourite stays, outside Other views, and so does My projects.
    await expect(tab.locator("#fav-work")).toBeVisible();
    await expect(tab.locator("#my-mail")).toBeVisible();
    await expect(
      tab.getByText("1 other task in the mail project"),
    ).toBeVisible();
    await tab.goBack();
    await expect(nav.getByRole("button", { name: "Mail" })).not.toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(
      tab.getByRole("heading", { name: "Native list" }),
    ).toBeVisible();
    await expect(tab.locator("#fav-mail")).toBeHidden();
    await expect(tab.locator("#projects #my-mail")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("Category and Inbox buttons show on hover or focus only; one click files at once and focus moves on", async () => {
  const { context, worker } = await launchMailbox();
  try {
    const tab = await context.newPage();
    await tab.goto("https://app.todoist.com/app/today?todoist-plus=mailbox");
    const list = tab.getByRole("list", { name: "Mail" });
    const first = list.getByRole("listitem").first();
    const group = first.locator(".plus-mailbox-actions");
    const category = first.getByRole("button", {
      name: "File as “Work · P2”: Synthetic cloud bill",
    });
    const inbox = first.getByRole("button", {
      name: "Move to Todoist Inbox: Synthetic cloud bill",
    });
    const shown = async () => ({
      buttons: await group.evaluate(
        (element) => getComputedStyle(element).opacity,
      ),
      time: await first
        .locator("time")
        .evaluate((time) => getComputedStyle(time).visibility),
    });
    await tab.mouse.move(5, 860);
    expect(await shown()).toEqual({ buttons: "0", time: "visible" });
    await first.hover();
    expect(await shown()).toEqual({ buttons: "1", time: "hidden" });
    // The title fades out under the buttons, in the 24px left of them.
    expect(
      await group.evaluate((element) => {
        const fade = getComputedStyle(element, "::before");
        return [fade.width, fade.backgroundImage.startsWith("linear-gradient")];
      }),
    ).toEqual(["24px", true]);
    // The categories first, Inbox at the right edge, with 4px between them.
    await expect(group.getByRole("button")).toHaveText(["Work · P2", "Inbox"]);
    const [left, right] = [
      (await category.boundingBox())!,
      (await inbox.boundingBox())!,
    ];
    expect(Math.round(right.x - (left.x + left.width))).toBe(4);
    // A click on the title's faded end opens the row; it never files.
    const buttons = (await group.boundingBox())!;
    await tab.mouse.click(buttons.x - 12, buttons.y + buttons.height / 2);
    const rows = list.locator(".plus-mailbox-row");
    await expect(rows.first()).toHaveAttribute("aria-expanded", "true");
    await tab.keyboard.press("Escape");
    await expect(rows.first()).toHaveAttribute("aria-expanded", "false");
    await tab.mouse.move(5, 860);

    const keys = await listenOnTodoist(tab);
    await rows.first().focus();
    await tab.keyboard.press("j");
    await expect(rows.nth(1)).toBeFocused();
    await tab.keyboard.press("k");
    await expect(rows.first()).toBeFocused();
    await tab.keyboard.press("Tab");
    await expect(category).toBeFocused();
    expect((await shown()).buttons).toBe("1");
    await tab.keyboard.press("Tab");
    await expect(inbox).toBeFocused();
    await tab.keyboard.press("Enter");
    await expect(list.getByText("Synthetic cloud bill")).toHaveCount(0);
    await expect(tab.getByRole("menu")).toHaveCount(0);
    await expect(tab.locator(".plus-mailbox-status")).toHaveText(
      "Moved to Todoist Inbox: Synthetic cloud bill",
    );
    await expect(rows.first()).toBeFocused();
    // One write without a category; the project an older build chose plays no part.
    expect(
      (await calls(worker, "mailItems:fileMailItem")).map((call) => call.body),
    ).toEqual([
      {
        task_id: "m-bill",
        etag: "m-bill-1",
        request_id: expect.any(String),
        category_id: "",
        // Ignored without a category, so not sent: a categories edit leaves the request as it was.
        categories_etag: "",
      },
    ]);
    expect(await projectOf(worker, "m-bill")).toBe("account-inbox");
    // j, k, Tab and Enter stayed in Plus: Todoist's shortcuts never saw them.
    expect(await keys()).toEqual([]);
  } finally {
    await context.close();
  }
});

test("at rest the time alone takes the row's side, whatever the categories; a long label keeps its priority", async () => {
  const { context, worker } = await launchMailbox();
  try {
    await worker.evaluate(() => {
      const state = (
        globalThis as unknown as {
          plannerState: MailState & {
            extraLabels: { id: string; label: string }[];
          };
        }
      ).plannerState;
      state.extraLabels.push({
        id: "synthetic-reading",
        label: "reading-list-for-the-weekend",
      });
      state.tasks.find((task) => task.id === "m-bill")!.title =
        "Synthetic cloud bill for October, with every service listed one after another and a note on the next billing period";
      const category = (id: string, label: string, priority: string) => ({
        id,
        label: { provider: "todoist", external_id: label },
        priority,
      });
      // Four, the most a Mailbox offers: the same long label twice, with two priorities.
      state.mailSettings.categories = [
        category("category-1", "synthetic-office", "p2"),
        category("category-2", "synthetic-reading", "p4"),
        category("category-3", "synthetic-reading", "p1"),
        category("category-4", "synthetic-home", "p3"),
      ];
    });
    const tab = await context.newPage();
    await tab.setViewportSize({ width: 1280, height: 900 });
    await tab.goto("https://app.todoist.com/app/today?todoist-plus=mailbox");
    const first = tab
      .getByRole("list", { name: "Mail" })
      .getByRole("listitem")
      .first();
    await expect(first.locator(".plus-mailbox-action")).toHaveCount(5);
    await tab.mouse.move(5, 860);
    const box = async (selector: string) =>
      (await first.locator(selector).first().boundingBox())!;
    const side = await box(".plus-mailbox-side");
    const time = await box("time");
    const title = await box(".plus-mailbox-title");
    // The time and the slot's 12px padding, inside the row's 112px reserve: the title's own
    // ellipsis ends before it, so the slot's background covers none of the title.
    expect(Math.round(side.width)).toBe(Math.round(time.width + 12));
    expect(side.width).toBeLessThan(112);
    expect(side.x).toBeGreaterThanOrEqual(title.x + title.width);
    expect(
      await first
        .locator(".plus-mailbox-title")
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(true);
    // On hover the buttons cover the title's end. A long label ends in an ellipsis; every
    // priority shows in full, inside its button, with the space before its "·" as rendered.
    await first.hover();
    const parts = await first
      .locator(".plus-mailbox-action")
      .evaluateAll((buttons) =>
        buttons.slice(0, 4).map((button) => {
          const label = button.querySelector(".plus-mailbox-action-label")!;
          const priority = button.querySelector<HTMLElement>(
            ".plus-mailbox-action-priority",
          )!;
          return {
            clipped: label.scrollWidth > label.clientWidth,
            priority: priority.innerText,
            inside:
              priority.getBoundingClientRect().right <=
              button.getBoundingClientRect().right,
          };
        }),
      );
    expect(parts).toEqual([
      { clipped: false, priority: " · P2", inside: true },
      { clipped: true, priority: " · P4", inside: true },
      { clipped: true, priority: " · P1", inside: true },
      { clipped: false, priority: " · P3", inside: true },
    ]);
  } finally {
    await context.close();
  }
});

test("a row expands in place to its summary as text, never as HTML", async () => {
  const { context, worker } = await launchMailbox();
  try {
    const tab = await context.newPage();
    await tab.goto("https://app.todoist.com/app/today?todoist-plus=mailbox");
    const row = tab.getByRole("button", { name: /^Synthetic cloud bill, / });
    await row.click();
    await expect(row).toHaveAttribute("aria-expanded", "true");
    const detail = tab.getByRole("region", { name: "Synthetic cloud bill" });
    await expect(detail.getByText("- Amount: 128")).toBeVisible();
    await expect(
      detail.getByText(
        "<img src=x onerror=alert(1)> https://example.test/bill",
      ),
    ).toBeVisible();
    await expect(detail.locator("img")).toHaveCount(0);
    await expect(
      detail.getByRole("link", { name: "Open in Todoist" }),
    ).toHaveAttribute("href", "https://app.todoist.com/app/task/m-bill");
    await tab.keyboard.press("Escape");
    await expect(detail).toBeHidden();
    expect(await calls(worker, "mailItems:readMailSummary")).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("Delete all confirms the count with focus on Cancel, and deletes exactly the frozen untouched mail", async () => {
  const { context, worker } = await launchMailbox();
  try {
    const tab = await context.newPage();
    await tab.goto("https://app.todoist.com/app/today?todoist-plus=mailbox");
    const deleteAll = tab.getByRole("button", { name: "Delete all" });
    await deleteAll.click();
    const dialog = tab.getByRole("dialog", { name: "Delete 2 emails?" });
    await expect(
      dialog.getByText(
        "Their 2 tasks will be permanently deleted from Todoist. This can't be undone.",
      ),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        "2 you've changed or planned are kept: Synthetic planned mail, Synthetic labelled mail.",
      ),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    // A screen reader hears the warning and what is kept with the title.
    await expect(dialog).toHaveAccessibleDescription(
      "Their 2 tasks will be permanently deleted from Todoist. This can't be undone. " +
        "2 you've changed or planned are kept: Synthetic planned mail, Synthetic labelled mail.",
    );
    // Neutral: the confirm button has no colour of its own.
    const confirm = dialog.getByRole("button", { name: "Delete 2" });
    expect(
      await confirm.evaluate(
        (button) => getComputedStyle(button).backgroundColor,
      ),
    ).toBe("rgba(0, 0, 0, 0)");
    await tab.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(await calls(worker, "mailItems:deleteMailItems")).toEqual([]);

    await deleteAll.click();
    await dialog.getByRole("button", { name: "Delete 2" }).click();
    await expect(dialog).toBeHidden();
    await expect(tab.locator(".plus-mailbox-status")).toHaveText(
      "Deleted 2 emails",
    );
    expect(
      (await calls(worker, "mailItems:deleteMailItems")).map(
        (call) => call.body,
      ),
    ).toEqual([
      { request_id: expect.any(String), task_ids: ["m-hike", "m-bill"] },
    ]);
    await expect(tab.locator(".plus-mailbox-title")).toHaveText([
      "Synthetic planned mail",
      "Synthetic labelled mail",
    ]);
    await expect(deleteAll).toBeHidden();
  } finally {
    await context.close();
  }
});

test("Mail categories saves labels and priorities, with no destination", async () => {
  const { context, worker } = await launchMailbox();
  try {
    const tab = await context.newPage();
    await tab.goto("https://app.todoist.com/app/today?todoist-plus=mailbox");
    const opener = tab.getByRole("button", { name: "Mail categories" });
    await opener.click();
    const dialog = tab.getByRole("dialog", { name: "Mail categories" });
    await expect(dialog.getByRole("combobox", { name: "Label 1" })).toHaveValue(
      "synthetic-office",
    );
    // A label and a priority per category: nothing asks where filed mail goes.
    await expect(dialog.getByRole("combobox")).toHaveCount(2);
    await expect(
      dialog.getByText(
        "Each category is one existing Todoist label and a priority. Filing adds them and moves the task to the Todoist Inbox.",
      ),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Add a category" }).click();
    const label = dialog.getByRole("combobox", { name: "Label 2" });
    await expect(label.locator("option")).toHaveText([
      "Choose a label",
      "Work",
      "Personal",
    ]);
    await label.selectOption("synthetic-home");
    await dialog
      .getByRole("combobox", { name: "Priority 2" })
      .selectOption("3");
    await dialog.getByRole("button", { name: "Save" }).click();
    // Saved: the dialog closes, as Planning labels does, the status line says so, and focus is
    // back on the header's button.
    await expect(dialog).toBeHidden();
    await expect(tab.locator(".plus-mailbox-status")).toHaveText(
      "Mail categories saved",
    );
    await expect(opener).toBeFocused();
    expect(
      (await calls(worker, "mailSettings:updateMailSettings")).map(
        (call) => call.body,
      ),
    ).toEqual([
      {
        categories: [
          {
            label: { provider: "todoist", external_id: "synthetic-office" },
            priority: "p2",
          },
          {
            label: { provider: "todoist", external_id: "synthetic-home" },
            priority: "p3",
          },
        ],
        // REQUIRED on the wire, and ignored.
        destination: { provider: "todoist", external_id: "inbox" },
        etag: "mail-1",
      },
    ]);
    const first = tab
      .getByRole("list", { name: "Mail" })
      .getByRole("listitem")
      .first();
    await first.hover();
    await expect(
      first.locator(".plus-mailbox-actions").getByRole("button"),
    ).toHaveText(["Work · P2", "Personal · P3", "Inbox"]);
    // Filing by a category: its label and priority, and the move to the account's Inbox.
    await first
      .getByRole("button", { name: /^File as “Personal · P3”/u })
      .click();
    await expect(tab.locator(".plus-mailbox-status")).toHaveText(
      "Filed as “Personal · P3”: Synthetic cloud bill",
    );
    expect(
      (await calls(worker, "mailItems:fileMailItem")).map(
        (call) => call.body.category_id,
      ),
    ).toEqual(["category-2"]);
    expect(await projectOf(worker, "m-bill")).toBe("account-inbox");
  } finally {
    await context.close();
  }
});

test("the list keeps its place through consecutive filings, and the result line is there from the start", async () => {
  const { context, worker } = await launchMailbox();
  try {
    const tab = await context.newPage();
    await tab.goto("https://app.todoist.com/app/today?todoist-plus=mailbox");
    const list = tab.getByRole("list", { name: "Mail" });
    const status = tab.locator(".plus-mailbox-status");
    // The live region is there before any write, empty, so the first result is read out too.
    await expect(status).toHaveAttribute("role", "status");
    await expect(status).toHaveText("");
    const top = async () => Math.round((await list.boundingBox())!.y);
    const start = await top();
    const fileFirst = async () => {
      const first = list.getByRole("listitem").first();
      await first.hover();
      await first
        .getByRole("button", { name: /^Move to Todoist Inbox: / })
        .click();
    };
    await fileFirst();
    await expect(status).toHaveText(
      "Moved to Todoist Inbox: Synthetic cloud bill",
    );
    expect(await top()).toBe(start);
    await controlWrites(worker, { hold: true });
    await fileFirst();
    await expect(list.locator(".plus-mailbox-item.is-pending")).toHaveCount(1);
    // While the next filing waits, the last result stays and nothing above the list moves.
    expect(await top()).toBe(start);
    await expect(status).toHaveText(
      "Moved to Todoist Inbox: Synthetic cloud bill",
    );
    // The waiting row shows the mark in place of its buttons; the other rows can still be filed.
    await expect(
      list.locator(".plus-mailbox-item.is-pending .plus-mailbox-action"),
    ).toHaveCount(0);
    const other = list.getByRole("listitem").nth(1);
    await other.hover();
    await expect(
      other.getByRole("button", { name: /^Move to Todoist Inbox: / }),
    ).toBeEnabled();
    await controlWrites(worker, { hold: false, release: true });
    await expect(status).toHaveText(
      "Moved to Todoist Inbox: Synthetic hike sign-up",
    );
    expect(await top()).toBe(start);
  } finally {
    await context.close();
  }
});
