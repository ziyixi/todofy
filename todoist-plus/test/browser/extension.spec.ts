import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Worker,
} from "@playwright/test";
import { resolve } from "node:path";

const fixture = `<!doctype html><html lang="en"><head><style>
body { margin:0; color:#202020; background:white; font-family:system-ui }
body.dark { color:#e5e5e5; background:#1e1e1e }
aside { width:280px; background:#fcfcf8; position:fixed; top:0; bottom:0 }
body.dark aside { background:#24251f }
main { margin-left:280px; min-height:100vh; color:inherit }
a { color:inherit } [hidden] { display:none !important }
</style></head><body><aside data-testid="app-sidebar-scrollable-container"><ul id="top-menu"><li><a href="/app/today">Today</a></li><li><a href="/app/upcoming">Upcoming</a></li></ul><ul><li id="legacy"><a href="/app/filter/committed-f1">Legacy commitment filter</a></li><li><a href="/app/project/email-inbox">Email Inbox</a></li></ul></aside><main id="content"><section id="native"><h1>Native task list</h1></section></main><script>
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
      if (url.pathname.endsWith("/flows/2026-10-13"))
        return json({
          name: "flows/2026-10-13",
          task_ids: ["child", "local-one", "__flowday_misc__:2026-10-13"],
          completed_task_ids: state.completed ? ["child"] : [],
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
        return json({ name: "timerSession", state: "running", etag: "9" });
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
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await expect(
      page.getByText("Synthetic project", { exact: true }),
    ).toBeVisible();
    await expect(page.locator("#native")).toBeHidden();
    await expect(page.locator("#legacy")).toBeHidden();
    await expect(page.getByRole("link", { name: "Email Inbox" })).toBeVisible();
    await page.getByRole("link", { name: "Today", exact: true }).click();
    await expect(page.locator("#native")).toBeVisible();
    await expect(
      page.getByText("Synthetic project", { exact: true }),
    ).toBeHidden();
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
    await page.getByText("Synthetic project", { exact: true }).click();
    await page
      .getByRole("button", { name: "Open in Todoist", exact: true })
      .click();
    await expect(page).toHaveURL("https://app.todoist.com/app/task/parent");
  } finally {
    await context.close();
  }
});

test("native task detail keeps work labels, hides replaced labels only with controls, and follows dark theme", async () => {
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
      document.body.classList.add("dark");
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
    await expect(page.locator("#commit-badge")).toBeHidden();
    await expect(page.locator("#office-badge")).toBeVisible();
    expect(
      await page
        .locator("todoist-plus-task-tools")
        .evaluate(
          (host) =>
            getComputedStyle(host.shadowRoot!.querySelector(".plus-root")!)
              .color,
        ),
    ).toBe("rgb(229, 229, 229)");
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
    await expect(page.locator("#native")).toBeHidden();
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
