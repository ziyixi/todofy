import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Worker,
} from "@playwright/test";
import { resolve } from "node:path";
import { themeCss, tokenColor } from "./theme";

// The owner's Kale theme; the other public themes switch by the <html> class. The native
// selected row's token roles are an assumption until the live page check confirms them
// (docs/verification.md), so a match with Plus's row here is no evidence on its own.
const fixture = `<!doctype html><html lang="en" class="theme_kale"><head><style id="todoist-theme">${themeCss}</style><style>
body { margin:0; color:var(--product-library-display-primary-idle-tint); background:var(--product-library-background-base-primary); font-family:system-ui }
aside { width:280px; padding:12px; box-sizing:border-box; background:var(--product-library-background-base-secondary); position:fixed; top:0; bottom:0 }
main { margin-left:280px; min-height:100vh; color:inherit }
a { color:inherit } [hidden] { display:none !important }
aside ul { margin:0; padding:0; list-style:none }
#top-menu a { display:flex; align-items:center; box-sizing:border-box; width:230px; height:34px; padding:5px; font-size:13px; line-height:20px; font-weight:400; text-decoration:none }
#top-menu svg { width:24px; height:24px }
#top-menu .current > a { background:var(--product-library-selectable-secondary-selected-fill); color:var(--product-library-selectable-secondary-on-selected-fill) }
</style></head><body><aside data-testid="app-sidebar-scrollable-container"><ul id="top-menu"><li id="native-today" class="current"><a href="/app/today"><svg aria-hidden="true"></svg><span>Today</span></a></li><li><a href="/app/upcoming"><svg aria-hidden="true"></svg><span>Upcoming</span></a></li></ul><ul id="favorites">
<div><li><div><div><a href="/app/project/email-inbox">Email Inbox</a><span>0</span></div></div></li></div>
<div id="legacy-wrapper"><li id="legacy"><div><div><a href="/app/filter/committed-f1">Legacy commitment filter</a><span>0</span></div></div></li></div>
<div id="extra-filter-wrapper"><li><div><div><a href="/app/filter/waiting-f2">Waiting / Blocked</a><span>0</span></div></div></li></div>
<div id="managed-label-wrapper"><li><div><div><a href="/app/label/committed-l1">committed</a></div></div></li></div>
<div id="extra-label-wrapper"><li><div><div><a href="/app/label/context-l3">Custom context</a></div></div></li></div>
<div id="separator-wrapper"><li><div><div><a href="/app/filter/separator-f3">--------</a></div></div></li></div>
</ul></aside><main id="content"><section id="native"><h1>Native task list</h1></section></main><script>
document.querySelector('a[href="/app/today"]').addEventListener('click',e=>{e.preventDefault();history.pushState(null,'','/app/today');window.dispatchEvent(new PopStateEvent('popstate'));});
</script></body></html>`;

async function setup(context: BrowserContext, worker: Worker) {
  await worker.evaluate(async () => {
    const storage = (
      globalThis as unknown as {
        chrome: { storage: { local: { set(value: unknown): Promise<void> } } };
      }
    ).chrome.storage;
    await storage.local.set({
      connection: {
        apiOrigin: "https://api.example.test",
        token: "synthetic-extension-token",
      },
    });
    const state = {
      calls: [] as {
        path: string;
        body: Record<string, unknown>;
        bearer: string | null;
      }[],
      completed: false,
      enabled: true,
      failReadPlan: false,
      failCompletion: true,
      failTimer: true,
      timerEtag: "7",
      focusTaskIds: ["child", "local-one", "__flowday_misc__:2026-10-13"],
      // While set, Plus API answers wait until a test releases them.
      holdReads: false,
      held: [] as (() => void)[],
    };
    Object.assign(globalThis, { testState: state });
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      state.calls.push({
        path: url.pathname,
        body,
        bearer: new Headers(init?.headers).get("authorization"),
      });
      if (state.holdReads && url.pathname.startsWith("/api/plus/v1/"))
        await new Promise<void>((resolve) => state.held.push(resolve));
      const json = (value: unknown, status = 200) =>
        Promise.resolve(
          new Response(JSON.stringify(value), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
        );
      if (url.pathname === "/api/plus/v1/plan:read" && state.failReadPlan)
        return json(
          {
            error: {
              status: "UNAUTHENTICATED",
              message: "Connection expired or revoked",
            },
          },
          401,
        );
      if (url.pathname === "/api/plus/v1/plan:read")
        return json({
          plan: {
            timezone: "UTC",
            week_start: "2026-10-12",
            today: "2026-10-13",
            enabled: state.enabled,
            flowday_url: "https://flowday.example.test",
            hidden_filter_ids: ["f1"],
            labels: [
              { role: "committed", id: "l1", label: "committed" },
              { role: "office", id: "l2", label: "office" },
            ],
          },
        });
      if (url.pathname === "/api/plus/v1/tasks")
        return json({
          planning_tasks: [
            {
              id: "parent",
              title: "Synthetic project",
              area: "work",
              stage: "committed",
              etag: "parent-1",
            },
            ...(!state.completed
              ? [
                  {
                    id: "child",
                    title: "Synthetic small step",
                    parent_id: "parent",
                    area: "unassigned",
                    stage: "none",
                    etag: "child-1",
                  },
                ]
              : []),
          ],
        });
      const flowDate = url.pathname.match(
        /\/flows\/(\d{4}-\d{2}-\d{2})$/u,
      )?.[1];
      if (flowDate)
        return json({
          name: `flows/${flowDate}`,
          task_ids: flowDate === "2026-10-13" ? state.focusTaskIds : [],
          completed_task_ids:
            flowDate === "2026-10-13" && state.completed ? ["child"] : [],
        });
      if (url.pathname.endsWith("/timerSession"))
        return json({
          name: "timerSession",
          state: "idle",
          etag: state.timerEtag,
        });
      if (url.pathname.endsWith("/tasks"))
        return json({
          tasks: [
            {
              name: "tasks/child",
              todoist_id: "child",
              title: "Synthetic small step",
              estimated_minutes: 30,
            },
            {
              name: "tasks/local-one",
              title: "Local planning note",
              estimated_minutes: 15,
            },
          ],
        });
      if (url.pathname.endsWith(":completeTask")) {
        if (state.failCompletion) {
          state.failCompletion = false;
          throw new TypeError("Synthetic response loss");
        }
        state.completed = true;
        return json({ task_id: "child" });
      }
      if (url.pathname.endsWith("/timerSession:command")) {
        if (state.failTimer) {
          state.failTimer = false;
          state.timerEtag = "8";
          return json(
            {
              error: {
                status: "ABORTED",
                message: "Timer changed in another window",
              },
            },
            409,
          );
        }
        return json({
          name: "timerSession",
          state: "running",
          etag: "9",
          task_id: body.task_id,
          flow_date: body.flow_date,
        });
      }
      throw new Error("Unexpected synthetic API path");
    };
  });
  await context.route("https://app.todoist.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: fixture }),
  );
}

test("built MV3 mounts, restores native UI and sends task actions through its background", async () => {
  const extensionPath = resolve(".output/chrome-mv3");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    await setup(context, worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await expect(page.locator("#legacy")).toBeHidden();
    await expect(page.locator("#native")).toBeVisible();
    await expect(page.locator("#extra-filter-wrapper")).toBeHidden();
    await expect(page.locator("#extra-label-wrapper")).toBeHidden();
    await page.getByRole("button", { name: /^Other views\s*2$/u }).click();
    await expect(page.locator("#extra-filter-wrapper")).toBeVisible();
    await expect(page.locator("#extra-label-wrapper")).toBeVisible();
    await expect(page.locator("#legacy-wrapper")).toBeHidden();
    await expect(page.locator("#managed-label-wrapper")).toBeHidden();
    await expect(page.locator("#separator-wrapper")).toBeHidden();
    await expect(page.locator("#favorites > div")).toHaveCount(6);
    await page.getByRole("button", { name: /^Other views\s*2$/u }).click();
    await expect(page.locator("#extra-filter-wrapper")).toBeHidden();
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    const parentTask = page.locator('.review-board [data-outcome-id="parent"]');
    await expect(parentTask).toBeVisible();
    await expect(page.locator("#native")).toBeHidden();
    await expect(page.locator("#legacy")).toBeHidden();
    const selected = await tokenColor(
      page,
      "selectable-secondary-selected-fill",
    );
    const planButton = page.getByRole("button", { name: "Plan", exact: true });
    await planButton.hover();
    await expect(planButton).toHaveCSS("background-color", selected);
    await expect(planButton).toHaveCSS(
      "color",
      await tokenColor(page, "selectable-secondary-on-selected-fill"),
    );
    await expect(planButton).toHaveCSS("padding", "5px");
    await expect(planButton).toHaveCSS("width", "230px");
    await expect(planButton).toHaveCSS("font-size", "13px");
    await expect(planButton.locator(".plus-nav-icon")).toHaveCSS(
      "width",
      "24px",
    );
    await expect(planButton.locator(".plus-nav-icon svg")).toHaveCSS(
      "width",
      "18px",
    );
    await expect(planButton.locator(".plus-nav-icon svg")).toHaveCSS(
      "height",
      "18px",
    );
    await expect(page.locator("#native-today")).toHaveClass("current");
    await expect(page.locator("#native-today > a")).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(page.getByRole("link", { name: "Email Inbox" })).toBeVisible();
    await page.getByRole("link", { name: "Today", exact: true }).click();
    await expect(page.locator("#native")).toBeVisible();
    await expect(page.locator("#native-today > a")).toHaveCSS(
      "background-color",
      selected,
    );
    await expect(parentTask).toBeHidden();
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    await expect(
      page.getByText("Local planning note", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Miscellaneous time", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Complete task: Local planning note" }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Open FlowDay" })).toHaveCount(
      2,
    );
    await page
      .getByRole("button", { name: "Start: Synthetic small step" })
      .click();
    await expect(page.getByRole("alert")).toContainText(
      "Timer changed in another window",
    );
    await page
      .getByRole("button", { name: "Start: Synthetic small step" })
      .click();
    await expect(
      page.getByRole("button", { name: "Pause: Synthetic small step" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Complete task: Synthetic small step" })
      .click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(
      page.getByText("Synthetic small step", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Complete task: Synthetic small step" })
      .click();
    await expect(
      page.getByText("Synthetic small step", { exact: true }),
    ).toHaveCount(0);
    const calls = await worker.evaluate(
      () =>
        (
          globalThis as unknown as {
            testState: {
              calls: {
                path: string;
                body: Record<string, unknown>;
                bearer: string | null;
              }[];
            };
          }
        ).testState.calls,
    );
    const completions = calls.filter((call) =>
      call.path.endsWith(":completeTask"),
    );
    expect(completions).toHaveLength(2);
    expect(completions[0]?.body.request_id).toBe(
      completions[1]?.body.request_id,
    );
    expect(
      calls
        .filter((call) => call.path.endsWith(":command"))
        .map((call) => call.body.etag),
    ).toEqual(["7", "8"]);
    expect(
      calls.every((call) => call.bearer === "Bearer synthetic-extension-token"),
    ).toBe(true);
    expect(
      await page.evaluate(() =>
        document.documentElement.outerHTML.includes(
          "synthetic-extension-token",
        ),
      ),
    ).toBe(false);
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await parentTask.click();
    await page
      .getByRole("button", { name: "Open in Todoist", exact: true })
      .click();
    await expect(page).toHaveURL("https://app.todoist.com/app/task/parent");
  } finally {
    await context.close();
  }
});

test("returning from a native page reloads Focus after an external queue change", async () => {
  const extensionPath = resolve(".output/chrome-mv3");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    await setup(context, worker);
    await worker.evaluate(() => {
      (
        globalThis as unknown as { testState: { focusTaskIds: string[] } }
      ).testState.focusTaskIds = [];
    });
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    const queuedStep = page.locator('.plus-focus-stack [data-task-id="child"]');
    await expect(
      page.getByRole("button", { name: "Adjust plan", exact: true }),
    ).toBeVisible();
    await expect(queuedStep).toHaveCount(0);
    await page.getByRole("link", { name: "Today", exact: true }).click();
    await expect(page.locator("#native")).toBeVisible();
    await worker.evaluate(() => {
      const state = (
        globalThis as unknown as {
          testState: { focusTaskIds: string[]; holdReads: boolean };
        }
      ).testState;
      state.focusTaskIds = ["child"];
      state.holdReads = true;
    });
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    // The last confirmed view paints at once; the re-read runs without locking it.
    await expect(
      page.getByRole("button", { name: "Adjust plan", exact: true }),
    ).toBeEnabled();
    await expect(page.locator(".plus-page-header .plus-spin")).toHaveCount(1);
    await expect(queuedStep).toHaveCount(0);
    await worker.evaluate(() => {
      const state = (
        globalThis as unknown as {
          testState: { holdReads: boolean; held: (() => void)[] };
        }
      ).testState;
      state.holdReads = false;
      for (const release of state.held.splice(0)) release();
    });
    await expect(queuedStep).toBeVisible();
    await expect(queuedStep).toContainText("Synthetic small step");
    await expect(page.locator("#native")).toBeHidden();
  } finally {
    await context.close();
  }
});

test("native task detail keeps work labels, hides replaced labels only with controls, and follows the dark theme", async () => {
  const extensionPath = resolve(".output/chrome-mv3");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    await setup(context, worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/task/parent");
    await page.evaluate(() => {
      document.documentElement.className = "theme_dark";
      document
        .querySelector("#content")!
        .insertAdjacentHTML(
          "beforeend",
          `<section data-testid="task-details-modal"><div data-testid="task-selection-list-container"><div data-item-id="parent"></div><div data-item-id="child"></div></div><div data-testid="task-main-content-container"><h2>Native detail</h2><a id="commit-badge" href="/app/label/committed-l1">committed</a><a id="office-badge" href="/app/label/office-l2">office</a></div></section>`,
        );
    });
    await page
      .getByRole("button", { name: "Steps & timing", exact: true })
      .click();
    await expect(
      page.getByText("Synthetic small step", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "In today: Synthetic small step" }),
    ).toBeDisabled();
    await expect(page.locator("#commit-badge")).toBeHidden();
    await expect(page.locator("#office-badge")).toBeVisible();
    // Todoist's dark text, on the modal's own surface.
    expect(
      await page.locator("todoist-plus-task-tools").evaluate((host) => {
        const style = getComputedStyle(
          host.shadowRoot!.querySelector(".plus-root")!,
        );
        return [style.color, style.backgroundColor];
      }),
    ).toEqual([
      await tokenColor(page, "display-primary-idle-tint"),
      "rgba(0, 0, 0, 0)",
    ]);
    await page
      .getByRole("button", { name: "Steps & timing", exact: true })
      .click();
    await expect(page.locator("#commit-badge")).toBeVisible();
    await page.evaluate(() => (document.documentElement.lang = "zh"));
    await expect(
      page.getByRole("button", { name: "计划", exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("task tools bind to the edited task, never a breadcrumb or a task the link does not name; Options says why they are off", async () => {
  const extensionPath = resolve(".output/chrome-mv3");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    await setup(context, worker);
    const page = await context.newPage();
    const openModal = () =>
      page.evaluate(() => {
        document.querySelector("[data-testid=task-details-modal]")?.remove();
        // The parent's breadcrumb carries an ID and renders before the selection list.
        document
          .querySelector("#content")!
          .insertAdjacentHTML(
            "beforeend",
            `<section data-testid="task-details-modal"><a data-item-id="parent" href="/app/task/parent">Synthetic project</a><div data-testid="task-selection-list-container"><div data-item-id="child"></div></div><div data-testid="task-main-content-container"><h2>Native detail</h2></div></section>`,
          );
      });
    await page.goto("https://app.todoist.com/app/task/child");
    await openModal();
    await page
      .getByRole("button", { name: "Steps & timing", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Estimate: Synthetic small step" }),
    ).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "Estimate: Synthetic project" }),
    ).toHaveCount(0);
    // A link that names another task: no tools at all, rather than the wrong task's.
    await page.evaluate(() =>
      history.replaceState(null, "", "/app/task/other"),
    );
    await openModal();
    await expect(
      page.getByRole("button", { name: "Steps & timing", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator("todoist-plus-task-tools")).toHaveCount(0);
    // The options page says which enhancement is off and why, in closed keys only.
    const options = await context.newPage();
    await options.goto(
      `chrome-extension://${new URL(worker.url()).host}/options.html`,
    );
    await expect(
      options.getByText(
        "Todoist page check: Steps & timing is off (the task ID did not match the page link)",
      ),
    ).toBeVisible();
    await page.evaluate(() =>
      history.replaceState(null, "", "/app/task/child"),
    );
    await openModal();
    await expect(page.locator("todoist-plus-task-tools")).toHaveCount(1);
    await options.reload();
    await expect(
      options.getByText("Todoist page check: all good"),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("Plan and Focus come back after Todoist re-creates its content and sidebar; its dialogs stay visible", async () => {
  const extensionPath = resolve(".output/chrome-mv3");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    await setup(context, worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today?todoist-plus=plan");
    const parentTask = page.locator('.review-board [data-outcome-id="parent"]');
    await expect(parentTask).toBeVisible();
    await page.evaluate(() => {
      const fresh = document.createElement("main");
      fresh.id = "content";
      fresh.innerHTML = `<section id="native-again"><h1>Native task list</h1></section>`;
      document.querySelector("#content")!.replaceWith(fresh);
    });
    await expect(parentTask).toBeVisible();
    await expect(page.locator("#native-again")).toBeHidden();
    await page.evaluate(() => {
      // A fresh sidebar, as a collapse and expand or the narrow-window drawer renders it.
      const aside = document.querySelector("aside")!;
      const fresh = aside.cloneNode(true) as HTMLElement;
      for (const host of fresh.querySelectorAll(
        "todoist-plus-navigation, todoist-plus-other-views",
      ))
        host.remove();
      for (const element of fresh.querySelectorAll<HTMLElement>("[hidden]")) {
        element.removeAttribute("hidden");
        element.style.removeProperty("display");
      }
      aside.replaceWith(fresh);
    });
    await expect(page.locator("todoist-plus-navigation")).toHaveCount(1);
    await expect(page.locator("#legacy")).toBeHidden();
    await expect(page.locator("#extra-filter-wrapper")).toBeHidden();
    await expect(
      page.getByRole("button", { name: /^Other views\s*2$/u }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Focus", exact: true }).click();
    await expect(
      page.getByText("Local planning note", { exact: true }),
    ).toBeVisible();
    await page.evaluate(() =>
      document
        .querySelector("#content")!
        .insertAdjacentHTML(
          "beforeend",
          `<div id="todoist-dialog" role="dialog">Synthetic Todoist dialog</div><div id="todoist-row">Synthetic native row</div>`,
        ),
    );
    await expect(page.locator("#todoist-dialog")).toBeVisible();
    await expect(page.locator("#todoist-row")).toBeHidden();
  } finally {
    await context.close();
  }
});

test("restores legacy controls when mapping or the extension connection becomes unavailable", async () => {
  const extensionPath = resolve(".output/chrome-mv3");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    await setup(context, worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await expect(page.locator("#legacy")).toBeHidden();
    await worker.evaluate(() => {
      (
        globalThis as unknown as { testState: { enabled: boolean } }
      ).testState.enabled = false;
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator("#legacy")).toBeVisible();
    await expect(page.locator("#managed-label-wrapper")).toBeVisible();
    await expect(page.locator("#extra-filter-wrapper")).toBeVisible();
    await expect(page.locator("#extra-label-wrapper")).toBeVisible();
    await expect(page.locator("#separator-wrapper")).toBeVisible();
    await expect(page.locator("todoist-plus-other-views")).toBeHidden();
    await expect(page.locator("#native")).toBeHidden();
    await expect(page.locator("#native-today > a")).toHaveCSS(
      "background-color",
      await tokenColor(page, "selectable-secondary-selected-fill"),
    );
    await worker.evaluate(() => {
      (
        globalThis as unknown as { testState: { enabled: boolean } }
      ).testState.enabled = true;
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.locator("#legacy")).toBeHidden();
    await worker.evaluate(() => {
      (
        globalThis as unknown as { testState: { failReadPlan: boolean } }
      ).testState.failReadPlan = true;
    });
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.locator("#legacy")).toBeVisible();
    await expect(page.locator("#native")).toBeHidden();
  } finally {
    await context.close();
  }
});

test("native pages read only plan settings and hide replaced items from the ID-only cache before it answers", async () => {
  const extensionPath = resolve(".output/chrome-mv3");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  try {
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    await setup(context, worker);
    const page = await context.newPage();
    await page.goto("https://app.todoist.com/app/today");
    await expect(page.locator("#legacy")).toBeHidden();
    await expect(page.locator("#extra-filter-wrapper")).toBeHidden();
    const state = () =>
      worker.evaluate(async () => {
        const global = globalThis as unknown as {
          testState: { calls: { path: string }[]; held: unknown[] };
          chrome: {
            storage: {
              local: { get(key: string): Promise<Record<string, unknown>> };
            };
          };
        };
        return {
          paths: global.testState.calls.map((call) => call.path),
          held: global.testState.held.length,
          cached: (await global.chrome.storage.local.get("planConfig"))
            .planConfig,
        };
      });
    const first = await state();
    expect(first.paths).toEqual(["/api/plus/v1/plan:read"]);
    expect(first.cached).toEqual({
      configured: true,
      hiddenFilterIds: ["f1"],
      labelIds: ["l1"],
    });
    await worker.evaluate(() => {
      (
        globalThis as unknown as { testState: { holdReads: boolean } }
      ).testState.holdReads = true;
    });
    await page.reload();
    await expect(
      page.getByRole("button", { name: /^Other views/u }),
    ).toBeVisible();
    await expect(page.locator("#legacy")).toBeHidden();
    await expect(page.locator("#extra-filter-wrapper")).toBeHidden();
    await expect(page.locator("#native")).toBeVisible();
    const second = await state();
    expect(second.held).toBe(1);
    expect(second.paths.slice(first.paths.length)).toEqual([
      "/api/plus/v1/plan:read",
    ]);
  } finally {
    await context.close();
  }
});
