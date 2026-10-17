import {
  chromium,
  expect,
  type BrowserContext,
  type Worker,
  type Page,
  type Locator,
} from "@playwright/test";
import { resolve } from "node:path";
import { themeCss } from "./theme";

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
      tasks: [
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

        {
          id: "quarter",
          title: "Synthetic quarter outcome",
          area: "work",
          stage: "quarterly",
          priority: 4,
          labels: ["quarter", "office", "context"],
          etag: "quarter-1",
        },
        {
          id: "month",
          title: "Synthetic month outcome",
          area: "personal",
          stage: "monthly",
          priority: 2,
          labels: ["candiate", "home"],
          etag: "month-1",
        },
        {
          id: "candidate",
          title: "Synthetic week candidate",
          area: "work",
          stage: "weekly",
          priority: 1,
          labels: ["focus", "office"],
          etag: "candidate-1",
        },
      ] as Record<string, unknown>[],
      labels: [
        "office",
        "home",
        "bets",
        "quarter",
        "candiate",
        "focus",
        "committed",
      ].map((role) => ({ role, id: `synthetic-${role}`, label: role })),
      // Account labels beyond the planning roles, such as the literal `active`.
      extraLabels: [] as { id: string; label: string }[],
      planEtag: "plan-1",
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
      // Weekly review IDs that ReadPlan adds to the plan (none by default).
      review: {} as Record<string, unknown>,
      // Todofy's dependencies, as the wire names them, and the prerequisites deleted in Todoist,
      // which a check removes; any other prerequisite a check names and no task list holds was
      // completed.
      dependencies: [] as Record<string, unknown>[],
      deleted: [] as string[],
      // WeeklyBets as Todofy keeps them (wire JSON), which SetWeeklyBet writes.
      bets: [] as Record<string, unknown>[],
      // Todofy's mail, as LookupMailItems answers it (wire JSON), each mail's summary by its ID,
      // and the mail settings. Filed mail always moves to the account's Inbox.
      mail: [] as Record<string, unknown>[],
      summaries: {} as Record<string, string>,
      mailSettings: { categories: [], etag: "mail-0" } as Record<
        string,
        unknown
      >,
      // While set, writes wait until a test releases them; failWrite rejects the next one.
      holdWrites: false,
      heldWrites: [] as (() => void)[],
      failWrite: false,
    };
    Object.assign(globalThis, { plannerState: state });
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      const method = init?.method ?? "GET";
      state.calls.push({ path: url.pathname, method, body });
      if (method !== "GET" && !url.pathname.endsWith("/tasks:sync")) {
        if (state.holdWrites)
          await new Promise<void>((resolve) => state.heldWrites.push(resolve));
        if (state.failWrite) {
          state.failWrite = false;
          return new Response(
            JSON.stringify({
              error: {
                status: "UNAVAILABLE",
                message: "Synthetic save unavailable",
              },
            }),
            { status: 503, headers: { "Content-Type": "application/json" } },
          );
        }
      }
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
            labels: state.labels,
            etag: state.planEtag,
            available_labels: [...state.labels, ...state.extraLabels].map(
              ({ id, label }) => ({ id, label }),
            ),
            hidden_filter_ids: [],
            dependencies: state.dependencies,
            weekly_bets: state.bets,
            ...state.review,
          },
        });
      if (url.pathname === "/api/plus/v1/tasks")
        return json({
          planning_tasks: state.tasks,
        });
      if (url.pathname.endsWith("/tasks:setTaskPlan")) {
        const task = state.tasks.find((task) => task.id === body.task_id);
        if (!task || task.etag !== body.etag)
          return new Response(
            JSON.stringify({
              error: { status: "ABORTED", message: "Synthetic task changed" },
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        if (body.stage !== undefined) {
          const roles: Record<string, string> = {
            quarterly: "quarter",
            monthly: "candiate",
            weekly: "focus",
            committed: "committed",
          };
          const labels = ((task.labels as string[]) ?? []).filter(
            (label) =>
              !["quarter", "candiate", "focus", "committed"].includes(label),
          );
          const stage = String(body.stage);
          if (roles[stage]) labels.push(roles[stage]!);
          task.stage = stage;
          task.labels = labels;
        }
        // The literal in-progress label; Todofy then lists the task as neither must start nor
        // missing a lead.
        if (body.active !== undefined) {
          const labels = ((task.labels as string[]) ?? []).filter(
            (label) => label !== "active",
          );
          task.labels = body.active ? [...labels, "active"] : labels;
          if (body.active) task.must_start = task.missing_lead = false;
        }
        task.etag = `${String(task.id)}-2`;
        return json({ task });
      }
      if (url.pathname.endsWith("/tasks:setTaskLead")) {
        const task = state.tasks.find((task) => task.id === body.task_id);
        if (!task || task.etag !== body.etag)
          return new Response(
            JSON.stringify({
              error: { status: "ABORTED", message: "Synthetic task changed" },
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        // Todofy's lead labels; a chosen lead is no longer missing.
        const leads: Record<number, string> = {
          1: "lead_1d",
          3: "lead_3d",
          7: "lead_1w",
          14: "lead_2w",
          30: "lead_1m",
        };
        const days = Number(body.lead_days ?? 0);
        task.labels = [
          ...((task.labels as string[]) ?? []).filter(
            (label) => !Object.values(leads).includes(label),
          ),
          ...(leads[days] ? [leads[days]!] : []),
        ];
        task.deadline = body.deadline;
        task.lead_days = days;
        task.missing_lead = Boolean(body.deadline) && !days;
        task.etag = `${String(task.id)}-2`;
        return json({ task });
      }
      if (url.pathname.endsWith("/weeklyBets:setWeeklyBet")) {
        // As Todofy answers: the saved text is a replay; only this week and the next take a
        // write, and only from the etag shown.
        const refuse = (code: number, status: string, reason: string) =>
          new Response(
            JSON.stringify({
              error: {
                code,
                status,
                message: "Synthetic refusal",
                details: [
                  {
                    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                    reason,
                    domain: "todofy.ziyixi.science",
                  },
                ],
              },
            }),
            { status: code, headers: { "Content-Type": "application/json" } },
          );
        const same = (bet: Record<string, unknown>) =>
          bet.week_start === body.week_start && bet.area === body.area;
        const saved = state.bets.find(same) ?? {
          week_start: body.week_start,
          area: body.area,
        };
        const text = String(body.text ?? "")
          .replace(/[\p{Cc}\s]+/gu, " ")
          .trim();
        if ((saved.text ?? "") === text) return json({ weekly_bet: saved });
        if (!["2026-10-12", "2026-10-19"].includes(String(body.week_start)))
          return refuse(400, "FAILED_PRECONDITION", "ACTION_NOT_ALLOWED");
        if ((body.etag ?? "") !== (saved.etag ?? ""))
          return refuse(409, "ABORTED", "ETAG_MISMATCH");
        const bet = {
          week_start: body.week_start,
          area: body.area,
          text,
          etag: String(Number(saved.etag ?? 0) + 1),
        };
        state.bets = [...state.bets.filter((item) => !same(item)), bet];
        return json({ weekly_bet: bet });
      }
      if (url.pathname.endsWith("/mailItems:lookup")) {
        const ids = (body.task_ids as string[] | undefined) ?? [];
        return json({
          items: state.mail.filter((item) =>
            ids.includes((item.task as { external_id: string }).external_id),
          ),
          categories: state.mailSettings.categories,
          categories_etag: state.mailSettings.etag,
          destination: state.mailSettings.destination,
        });
      }
      if (url.pathname.endsWith("/mailItems:readMailSummary"))
        return json({
          summary: state.summaries[url.searchParams.get("id") ?? ""] ?? "",
        });
      if (url.pathname.endsWith("/mailSettings:read"))
        // Todofy still answers the account Inbox for builds before protocol 6, which this one ignores.
        return json({
          ...state.mailSettings,
          destination: { provider: "todoist", external_id: "account-inbox" },
          projects: [
            { id: "account-inbox", display_name: "Inbox", inbox: true },
          ],
        });
      if (url.pathname.endsWith("/mailSettings:updateMailSettings")) {
        // As Todofy saves: the categories alone; the destination is kept as saved and ignored.
        const categories = (body.categories as Record<string, unknown>[]) ?? [];
        state.mailSettings = {
          ...state.mailSettings,
          categories: categories.map((category, index) => ({
            id: `category-${index + 1}`,
            ...category,
          })),
          etag: `mail-${Number(String(state.mailSettings.etag).slice(5)) + 1}`,
        };
        return json(state.mailSettings);
      }
      if (url.pathname.endsWith("/mailItems:fileMailItem")) {
        // As Todofy files, in one write: with a category its label and priority, and always the
        // move to the account's Inbox. Without one the categories' etag is not checked.
        const task = state.tasks.find((task) => task.id === body.task_id);
        const category = (
          state.mailSettings.categories as Record<string, unknown>[]
        ).find((item) => item.id === body.category_id);
        const label = [...state.labels, ...state.extraLabels].find(
          (item) =>
            item.id ===
            (category?.label as { external_id: string } | undefined)
              ?.external_id,
        );
        if (
          !task ||
          task.etag !== body.etag ||
          (body.category_id !== "" && (!category || !label))
        )
          return new Response(
            JSON.stringify({
              error: { status: "ABORTED", message: "Synthetic task changed" },
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        if (category && label) {
          task.labels = [...((task.labels as string[]) ?? []), label.label];
          task.priority = 5 - Number(String(category.priority).slice(1));
        }
        task.project_id = "account-inbox";
        task.etag = `${String(task.id)}-2`;
        return json({ task });
      }
      if (url.pathname.endsWith("/mailItems:deleteMailItems")) {
        // Todofy's own check on a fresh read: only untouched mail goes.
        const ids = body.task_ids as string[];
        const mail = new Set(
          state.mail.map(
            (item) => (item.task as { external_id: string }).external_id,
          ),
        );
        const deleted = state.tasks
          .filter(
            (task) =>
              ids.includes(String(task.id)) &&
              mail.has(String(task.id)) &&
              !((task.labels as string[] | undefined) ?? []).length &&
              (task.priority ?? 1) === 1 &&
              !task.due,
          )
          .map((task) => String(task.id));
        state.tasks = state.tasks.filter(
          (task) => !deleted.includes(String(task.id)),
        );
        return json({
          deleted_task_ids: deleted,
          kept_task_ids: ids.filter((id) => !deleted.includes(id)),
        });
      }
      if (url.pathname.endsWith("/tasks:completeTask")) {
        state.tasks = state.tasks.filter((task) => task.id !== body.task_id);
        // Todofy records the completion for what waits for the task.
        for (const dependency of state.dependencies)
          if (dependency.prerequisite_id === body.task_id)
            dependency.done = true;
        return json({ task_id: body.task_id });
      }
      if (url.pathname.endsWith("/tasks:setTaskDependency")) {
        const same = (dependency: Record<string, unknown>) =>
          dependency.task_id === body.task_id &&
          dependency.prerequisite_id === body.prerequisite_id;
        const prerequisite = state.tasks.find(
          (task) => task.id === body.prerequisite_id,
        );
        // As Todofy: one that holds stays as it is; a recurring one completed since starts over.
        const existing = state.dependencies.find(same);
        const done =
          prerequisite?.recurring &&
          Number(prerequisite.completed_count ?? 0) >
            Number(existing?.baseline_completed_count ?? 0);
        state.dependencies = [
          ...state.dependencies.filter((dependency) => !same(dependency)),
          ...(body.waits
            ? [
                existing && !done
                  ? existing
                  : {
                      task_id: body.task_id,
                      prerequisite_id: body.prerequisite_id,
                      baseline_completed_count:
                        prerequisite?.completed_count ?? 0,
                    },
              ]
            : []),
        ];
        return json({
          dependencies: state.dependencies.filter(
            (dependency) => dependency.task_id === body.task_id,
          ),
        });
      }
      if (url.pathname.endsWith("/tasks:resolveDependencies")) {
        // As Todofy settles them: a gone waiter's dependencies go, a deleted prerequisite's go and
        // its waiters are told, any other gone prerequisite is done.
        const asked = (body.task_ids as string[]).filter(
          (id) => !state.tasks.some((task) => task.id === id),
        );
        const deleted = (dependency: Record<string, unknown>) =>
          asked.includes(String(dependency.prerequisite_id)) &&
          state.deleted.includes(String(dependency.prerequisite_id));
        const dropped = state.dependencies
          .filter(deleted)
          .map((dependency) => String(dependency.task_id));
        state.dependencies = state.dependencies.filter(
          (dependency) =>
            !deleted(dependency) && !asked.includes(String(dependency.task_id)),
        );
        for (const dependency of state.dependencies)
          if (asked.includes(String(dependency.prerequisite_id)))
            dependency.done = true;
        return json({
          dependencies: state.dependencies,
          dropped_task_ids: dropped,
        });
      }
      if (url.pathname.endsWith("/plan:updatePlanLabels")) {
        state.labels = body.labels as {
          role: string;
          id: string;
          label: string;
        }[];
        state.planEtag = "plan-2";
        return json({
          plan: {
            timezone: "UTC",
            week_start: "2026-10-12",
            today: "2026-10-13",
            enabled: true,
            etag: state.planEtag,
            labels: state.labels,
            available_labels: state.labels.map(({ id, label }) => ({
              id,
              label,
            })),
          },
        });
      }
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
      body: `<!doctype html><html lang="en" class="theme_kale"><head><style id="todoist-theme">${themeCss}</style><style>body{margin:0;color:var(--product-library-display-primary-idle-tint);background:var(--product-library-background-base-primary);font-family:system-ui}aside{width:280px;position:fixed;inset:0 auto 0 0;background:var(--product-library-background-base-secondary)}main{margin-left:280px;min-height:100vh}#top-menu{padding:12px;list-style:none}#top-menu a{height:34px;padding:5px;display:flex;width:230px;font-size:13px;box-sizing:border-box}#top-menu svg{width:24px;height:24px}</style></head><body><aside data-testid="app-sidebar-scrollable-container"><ul id="top-menu"><li><a href="/app/today"><svg></svg><span>Today</span></a></li><li><a href="/app/upcoming"><svg></svg><span>Upcoming</span></a></li></ul></aside><main id="content"><h1>Native list</h1></main></body></html>`,
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

/** Plan's view as the extension stored it in storage.local. */
export async function storedPlanView(worker: Worker) {
  return worker.evaluate(async () => {
    const local = (
      globalThis as unknown as {
        chrome: {
          storage: {
            local: { get(key: string): Promise<Record<string, unknown>> };
          };
        };
      }
    ).chrome.storage.local;
    return (await local.get("planView")).planView;
  });
}

export async function dragPlanner(
  page: Page,
  handle: Locator,
  target: Locator,
) {
  await expect(
    page.locator("[data-dnd-overlay][data-dnd-dragging]"),
  ).toHaveCount(0);
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

type WriteControl = {
  holdWrites: boolean;
  heldWrites: (() => void)[];
  failWrite: boolean;
};
/** Holds, releases or fails the synthetic backend's writes. */
export async function controlWrites(
  worker: Worker,
  change: { hold?: boolean; release?: boolean; fail?: boolean },
) {
  return worker.evaluate((change) => {
    const state = (globalThis as unknown as { plannerState: WriteControl })
      .plannerState;
    if (change.hold !== undefined) state.holdWrites = change.hold;
    if (change.fail !== undefined) state.failWrite = change.fail;
    const held = state.heldWrites.length;
    if (change.release)
      for (const release of state.heldWrites.splice(0)) release();
    return held;
  }, change);
}

type DeadlineTasksState = {
  tasks: Record<string, unknown>[];
  extraLabels: { id: string; label: string }[];
};
/**
 * Synthetic deadline and waiting tasks, or `only` those IDs; today is 2026-10-13. Start now gets
 * the draft (past) and the claim, Committed the visa; the move is in progress, the insurance has
 * no lead, and Waiting gets the contract (with a deadline) and the quote.
 */
export async function addDeadlineTasks(
  worker: Worker,
  only?: readonly string[],
) {
  await worker.evaluate((only) => {
    const state = (
      globalThis as unknown as { plannerState: DeadlineTasksState }
    ).plannerState;
    const task = (id: string, title: string, fields = {}) => ({
      id,
      title,
      area: "work",
      stage: "none",
      etag: `${id}-1`,
      ...fields,
    });
    const tasks = [
      task("draft", "Quarterly report draft", {
        deadline: "2026-10-11",
        lead_days: 7,
        labels: ["lead_1w"],
        must_start: true,
      }),
      task("claim", "Submit the expense claim", {
        deadline: "2026-10-14",
        lead_days: 3,
        labels: ["lead_3d"],
        must_start: true,
      }),
      task("visa", "Prepare the visa documents", {
        stage: "committed",
        deadline: "2026-10-18",
        lead_days: 7,
        labels: ["committed", "lead_1w"],
        must_start: true,
      }),
      task("move", "Move house", {
        area: "personal",
        deadline: "2026-10-25",
        lead_days: 14,
        labels: ["active", "lead_2w"],
      }),
      task("insurance", "Renew the car insurance", {
        area: "personal",
        deadline: "2026-11-30",
        missing_lead: true,
      }),
      task("contract", "Contract signature", {
        deadline: "2026-10-20",
        lead_days: 7,
        labels: ["waiting", "lead_1w"],
        update_time: "2026-10-01T09:00:00Z",
      }),
      task("quote", "Quote reply", {
        labels: ["waiting"],
        update_time: "2026-10-10T09:00:00Z",
      }),
    ];
    state.tasks.push(
      ...tasks.filter((item) => !only || only.includes(item.id)),
    );
    state.extraLabels = [{ id: "synthetic-active", label: "active" }];
  }, only);
}

type DependencyTasksState = {
  tasks: Record<string, unknown>[];
  dependencies: Record<string, unknown>[];
};
/** The synthetic titles of addDependencyTasks, by task ID. */
export const DEPENDENCY_TITLES = {
  venue: "Book the venue",
  invite: "Send the invitations",
  program: "Plan the launch program",
  shelf: "Tidy the bookshelf",
  weekly: "Weekly launch sync",
};
/**
 * Synthetic tasks with dependencies; today is 2026-10-13. The program (no stage label, its start
 * window open) waits for the venue, and the shelf for the invitations, a commitment. The weekly sync
 * repeats, with Todoist's counter at 4.
 */
export async function addDependencyTasks(
  worker: Worker,
  titles: Record<keyof typeof DEPENDENCY_TITLES, string> = DEPENDENCY_TITLES,
) {
  await worker.evaluate((titles) => {
    const state = (
      globalThis as unknown as { plannerState: DependencyTasksState }
    ).plannerState;
    const task = (id: keyof typeof titles, fields = {}) => ({
      id,
      title: titles[id],
      area: "work",
      stage: "none",
      etag: `${id}-1`,
      ...fields,
    });
    state.tasks.push(
      task("venue", { update_time: "2026-10-05T09:00:00Z" }),
      task("invite", { stage: "committed", labels: ["committed"] }),
      task("program", {
        deadline: "2026-10-20",
        lead_days: 7,
        labels: ["lead_1w"],
        must_start: true,
        update_time: "2026-10-08T09:00:00Z",
      }),
      task("shelf", { area: "personal" }),
      task("weekly", { recurring: true, completed_count: 4 }),
    );
    state.dependencies.push(
      { task_id: "program", prerequisite_id: "venue" },
      { task_id: "shelf", prerequisite_id: "invite" },
    );
  }, titles);
}
