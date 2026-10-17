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
 * them in a FlowDay queue and one labelled, and the owner's own task. One category is saved.
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

test("File shows on hover or focus only; filing by keyboard writes once and focus moves on", async () => {
  const { context, worker } = await launchMailbox();
  try {
    const tab = await context.newPage();
    await tab.goto("https://app.todoist.com/app/today?todoist-plus=mailbox");
    const list = tab.getByRole("list", { name: "Mail" });
    const first = list.getByRole("listitem").first();
    const file = first.getByRole("button", {
      name: "File: Synthetic cloud bill",
    });
    const opacity = () =>
      file.evaluate((button) => getComputedStyle(button).opacity);
    const timeShown = () =>
      first
        .locator("time")
        .evaluate((time) => getComputedStyle(time).visibility);
    await tab.mouse.move(5, 860);
    expect(await opacity()).toBe("0");
    expect(await timeShown()).toBe("visible");
    await first.hover();
    expect(await opacity()).toBe("1");
    expect(await timeShown()).toBe("hidden");
    await tab.mouse.move(5, 860);

    const keys = await listenOnTodoist(tab);
    const rows = list.locator(".plus-mailbox-row");
    await rows.first().focus();
    await tab.keyboard.press("j");
    await expect(rows.nth(1)).toBeFocused();
    await tab.keyboard.press("k");
    await expect(rows.first()).toBeFocused();
    await tab.keyboard.press("Tab");
    await expect(file).toBeFocused();
    expect(await opacity()).toBe("1");
    await tab.keyboard.press("Enter");
    const menu = tab.getByRole("menu", { name: "File: Synthetic cloud bill" });
    await expect(menu.getByRole("menuitem")).toHaveText([
      "Work · P2",
      "Mail categories…",
    ]);
    await expect(
      menu.getByRole("menuitem", { name: "Work · P2" }),
    ).toBeFocused();
    await tab.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(file).toBeFocused();
    await tab.keyboard.press("Enter");
    await tab.keyboard.press("Enter");
    await expect(list.getByText("Synthetic cloud bill")).toHaveCount(0);
    await expect(tab.locator(".plus-mailbox-status")).toHaveText(
      "Filed as “Work · P2”: Synthetic cloud bill",
    );
    await expect(rows.first()).toBeFocused();
    expect(
      (await calls(worker, "mailItems:fileMailItem")).map((call) => call.body),
    ).toEqual([
      {
        task_id: "m-bill",
        etag: "m-bill-1",
        request_id: expect.any(String),
        category_id: "category-1",
        categories_etag: "mail-1",
      },
    ]);
    // j, k, Tab and Enter stayed in Plus: Todoist's shortcuts never saw them.
    expect(await keys()).toEqual([]);
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

test("Mail categories saves one label and a priority per category and the destination", async () => {
  const { context, worker } = await launchMailbox();
  try {
    const tab = await context.newPage();
    await tab.goto("https://app.todoist.com/app/today?todoist-plus=mailbox");
    const opener = tab.getByRole("button", { name: "Mail categories" });
    await opener.click();
    const dialog = tab.getByRole("dialog", { name: "Mail categories" });
    const destination = dialog.getByRole("combobox", {
      name: "Filed mail goes to",
    });
    await expect(destination).toHaveValue("work-project");
    await expect(dialog.getByRole("combobox", { name: "Label 1" })).toHaveValue(
      "synthetic-office",
    );
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
    // back on the button that opened it.
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
        destination: { provider: "todoist", external_id: "work-project" },
        etag: "mail-1",
      },
    ]);
    const first = tab
      .getByRole("list", { name: "Mail" })
      .getByRole("listitem")
      .first();
    await first.hover();
    await first.getByRole("button", { name: /^File: / }).click();
    await expect(tab.getByRole("menu").getByRole("menuitem")).toHaveText([
      "Work · P2",
      "Personal · P3",
      "Mail categories…",
    ]);
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
      await first.getByRole("button", { name: /^File: / }).click();
      await tab.getByRole("menuitem", { name: "Work · P2" }).click();
    };
    await fileFirst();
    await expect(status).toHaveText(
      "Filed as “Work · P2”: Synthetic cloud bill",
    );
    expect(await top()).toBe(start);
    await controlWrites(worker, { hold: true });
    await fileFirst();
    await expect(list.locator(".plus-mailbox-item.is-pending")).toHaveCount(1);
    // While the next filing waits, the last result stays and nothing above the list moves.
    expect(await top()).toBe(start);
    await expect(status).toHaveText(
      "Filed as “Work · P2”: Synthetic cloud bill",
    );
    // The other rows can still be filed.
    const other = list.getByRole("listitem").nth(1);
    await other.hover();
    await expect(other.getByRole("button", { name: /^File: / })).toBeEnabled();
    await controlWrites(worker, { hold: false, release: true });
    await expect(status).toHaveText(
      "Filed as “Work · P2”: Synthetic hike sign-up",
    );
    expect(await top()).toBe(start);
  } finally {
    await context.close();
  }
});
