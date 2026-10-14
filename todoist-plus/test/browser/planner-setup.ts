import {
  chromium,
  expect,
  type BrowserContext,
  type Worker,
  type Page,
  type Locator,
} from "@playwright/test";
import { resolve } from "node:path";

/** A real built extension and only synthetic Todoist/FlowDay data. */
export async function launchPlanner() {
  const extensionPath = resolve(".output/chrome-mv3");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    viewport: { width: 1854, height: 873 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  await setupPlanner(context, worker);
  return { context, worker };
}

async function setupPlanner(context: BrowserContext, worker: Worker) {
  await worker.evaluate(async () => {
    const storage = (
      globalThis as unknown as {
        chrome: { storage: { local: { set(value: unknown): Promise<void> } } };
      }
    ).chrome.storage;
    await storage.local.set({
      connection: {
        apiOrigin: "https://api.example.test",
        token: "synthetic-planner-token",
      },
    });
    const state = {
      days: { "2026-10-13": ["child", "local-one"] } as Record<
        string,
        string[]
      >,
      calls: [] as {
        path: string;
        method: string;
        body: Record<string, unknown>;
      }[],
      timer: { name: "timerSession", state: "idle", etag: "1" } as Record<
        string,
        unknown
      >,
    };
    Object.assign(globalThis, { plannerState: state });
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      const method = init?.method ?? "GET";
      state.calls.push({ path: url.pathname, method, body });
      const json = (value: unknown) =>
        Promise.resolve(
          new Response(JSON.stringify(value), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      const flow = (date: string) => ({
        name: `flows/${date}`,
        task_ids: state.days[date] ?? [],
        completed_task_ids: [],
      });
      if (url.pathname === "/api/plus/v1/plan:read")
        return json({
          plan: {
            timezone: "UTC",
            week_start: "2026-10-12",
            today: "2026-10-13",
            enabled: true,
            labels: [],
            hidden_filter_ids: [],
          },
        });
      if (url.pathname === "/api/plus/v1/tasks")
        return json({
          planning_tasks: [
            {
              id: "parent",
              title: "Synthetic weekly outcome",
              area: "work",
              stage: "committed",
              etag: "parent-1",
            },
            {
              id: "child",
              title: "Synthetic first step",
              parent_id: "parent",
              area: "unassigned",
              stage: "none",
              due: "2026-11-15",
              deadline: "2026-12-01",
              etag: "child-1",
            },
            {
              id: "second",
              title: "Synthetic second step",
              parent_id: "parent",
              area: "unassigned",
              stage: "none",
              etag: "second-1",
            },
          ],
        });
      const flowMatch = /\/flows\/(\d{4}-\d{2}-\d{2})(:rollover)?$/.exec(
        url.pathname,
      );
      if (flowMatch) {
        const date = flowMatch[1]!;
        if (flowMatch[2]) {
          const destination = String(body.destination).slice("flows/".length);
          const moved = (body.task_ids as string[]).filter((id) =>
            state.days[date]?.includes(id),
          );
          const target = state.days[destination] ?? [];
          state.days[destination] = [
            ...moved.filter((id) => !target.includes(id)),
            ...target,
          ];
          state.days[date] = (state.days[date] ?? []).filter(
            (id) => !moved.includes(id),
          );
          return json({
            flow: flow(date),
            destination_flow: flow(destination),
          });
        }
        if (method === "PATCH")
          state.days[date] = [...((body.task_ids as string[]) ?? [])];
        return json(flow(date));
      }
      if (url.pathname.endsWith("/timerSession")) return json(state.timer);
      if (url.pathname.endsWith("/tasks"))
        return json({
          tasks: [
            {
              name: "tasks/child",
              todoist_id: "child",
              title: "Synthetic first step",
              estimated_minutes: 30,
            },
            {
              name: "tasks/second",
              todoist_id: "second",
              title: "Synthetic second step",
              estimated_minutes: 60,
            },
            {
              name: "tasks/local-one",
              title: "Synthetic local note",
              estimated_minutes: 15,
            },
          ],
        });
      if (url.pathname.endsWith("/tasks:sync"))
        return json({ state: "synced" });
      throw new Error(`Unexpected synthetic planner route ${url.pathname}`);
    };
  });
  await context.route("https://app.todoist.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html lang="en"><head><style>body{margin:0;color:#202020;background:white;font-family:system-ui}aside{width:280px;position:fixed;inset:0 auto 0 0;background:#fcfcf8}main{margin-left:280px;min-height:100vh}#top-menu{padding:12px;list-style:none}#top-menu a{height:34px;padding:5px;display:flex;width:230px;font-size:13px;box-sizing:border-box}#top-menu svg{width:24px;height:24px}</style></head><body><aside data-testid="app-sidebar-scrollable-container"><ul id="top-menu"><li><a href="/app/today"><svg></svg><span>Today</span></a></li><li><a href="/app/upcoming"><svg></svg><span>Upcoming</span></a></li></ul></aside><main id="content"><h1>Native list</h1></main></body></html>`,
    }),
  );
}

export async function plannerDays(worker: Worker) {
  return worker.evaluate(
    () =>
      (
        globalThis as unknown as {
          plannerState: { days: Record<string, string[]> };
        }
      ).plannerState.days,
  );
}

export async function dragPlanner(
  page: Page,
  handle: Locator,
  target: Locator,
) {
  await expect(handle).toBeEnabled();
  await expect(target).toBeVisible();
  const sourceBox = await handle.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox)
    throw new Error("Synthetic drag target is not visible");
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2 + 8,
    sourceBox.y + sourceBox.height / 2,
    { steps: 3 },
  );
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 18 },
  );
  await page.mouse.up();
}
