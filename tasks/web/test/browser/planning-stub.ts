import {
  expect,
  request as apiRequest,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

export type Json = Record<string, unknown>;
export interface PlanningRequest {
  path: string;
  method: string;
  body: Json;
  authorization: string | null;
}
/** What the synthetic Todofy planning API holds; tests read and change it in place. */
export interface PlanningState {
  today: string;
  /** Plan fields over the defaults (a native plan for the week of 2026-10-12). */
  plan: Json;
  tasks: Json[];
  bets: Json[];
  dependencies: Json[];
  mail: Json[];
  summaries: Record<string, string>;
  requests: PlanningRequest[];
  /** The page's requests to the dev server's own Tasks API, which holds Focus. */
  tasksRequests: PlanningRequest[];
}
export interface PlanningSeed extends Partial<
  Omit<PlanningState, "requests" | "tasksRequests">
> {
  /**
   * Day queues to put in the dev server's D1 through MoveFocusStep, first to last. Each step's
   * task is made there first when it is missing (seedFocus).
   */
  queues?: Record<string, string[]>;
  /** Tasks a test drops into a day, which Tasks' queues need in its D1 as well. */
  inTasks?: string[];
}

const ORIGIN = "http://127.0.0.1:8798";

function refusal(code: number, status: string, reason: string) {
  return {
    status: code,
    json: {
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
    },
  };
}

/**
 * Answers `/api/plus/**` in the page as Todofy's planning API does for Tasks, from synthetic data
 * only. Every request is recorded; an unknown one fails with 500. Focus is the dev server's own:
 * its timer is stopped and the queues of the plan's week and of Tasks' today are emptied, then
 * filled from `queues` (seedFocus). With `tasksIn`, the task list leaves out a task the dev
 * server's D1 holds completed, as Todofy's list of Tasks' open tasks does.
 */
export async function stubPlanning(
  page: Page,
  { queues = {}, inTasks = [], ...seed }: PlanningSeed = {},
  tasksIn?: APIRequestContext,
): Promise<PlanningState> {
  const state: PlanningState = {
    today: "2026-10-13",
    plan: {},
    tasks: [],
    bets: [],
    dependencies: [],
    mail: [],
    summaries: {},
    requests: [],
    tasksRequests: [],
    ...seed,
  };
  await seedFocus(
    queues,
    String(state.plan.week_start ?? "2026-10-12"),
    state.tasks,
    inTasks,
  );
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/tasks/v1/")) return;
    state.tasksRequests.push({
      path: url.pathname + url.search,
      method: request.method(),
      body: (request.method() === "GET" ? {} : request.postDataJSON()) ?? {},
      authorization: request.headers()["authorization"] ?? null,
    });
  });
  const task = (id: unknown) => state.tasks.find((item) => item.id === id);
  await page.route("**/api/plus/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = (
      method === "GET" ? {} : (request.postDataJSON() ?? {})
    ) as Json;
    state.requests.push({
      path,
      method,
      body,
      authorization: request.headers()["authorization"] ?? null,
    });
    const answer = async (): Promise<
      { status?: number; json: unknown } | undefined
    > => {
      if (path === "/api/plus/v1/plan:read")
        return {
          json: {
            plan: {
              timezone: "America/Los_Angeles",
              week_start: "2026-10-12",
              today: state.today,
              enabled: true,
              native_planning: true,
              etag: "native-plan",
              inbox_project_id: "mail",
              labels: [],
              available_labels: [],
              mailbox_pending_count: state.mail.length,
              weekly_bets: state.bets,
              dependencies: state.dependencies,
              ...state.plan,
            },
          },
        };
      if (path === "/api/plus/v1/tasks")
        return {
          json: {
            planning_tasks: tasksIn
              ? await stillOpen(tasksIn, state.tasks)
              : state.tasks,
          },
        };
      if (path === "/api/plus/v1/tasks:setTaskPlan") {
        const saved = task(body.task_id)!;
        if (body.stage !== undefined) {
          saved.stage = body.stage;
          saved.explicit_stage = body.stage;
        }
        const flags = new Set(saved.planning_flags as string[]);
        for (const flag of ["quick", "active"] as const)
          if (body[flag] !== undefined) {
            if (body[flag]) flags.add(flag);
            else flags.delete(flag);
          }
        saved.planning_flags = [...flags];
        saved.etag = String(Number(saved.etag) + 1);
        return { json: { task: saved } };
      }
      if (path === "/api/plus/v1/tasks:reorder") {
        // The listed siblings take positions in the given order; a lane's order is saved with the plan.
        const ids = body.task_ids as string[];
        const lane = String(body.lane ?? "");
        const reordered = ids.flatMap((id, index) => {
          const saved = task(id);
          if (!saved) return [];
          saved.sort_order = index + 1;
          saved.etag = String(Number(saved.etag) + 1);
          return [saved];
        });
        if (!lane) return { json: { tasks: reordered } };
        const orders = (state.plan.lane_orders as Json[] | undefined) ?? [];
        state.plan = {
          ...state.plan,
          lane_orders: [
            ...orders.filter((order) => order.lane !== lane),
            { lane, task_ids: ids },
          ],
        };
        return {
          json: { tasks: reordered, lane_order: { lane, task_ids: ids } },
        };
      }
      if (path === "/api/plus/v1/tasks:setTaskLead") {
        const saved = task(body.task_id);
        if (!saved || saved.etag !== body.etag)
          return refusal(409, "ABORTED", "ETAG_MISMATCH");
        saved.deadline = body.deadline;
        saved.lead_days = body.lead_days ?? 0;
        saved.missing_lead = false;
        saved.etag = String(Number(saved.etag) + 1);
        return { json: { task: saved } };
      }
      if (path === "/api/plus/v1/tasks:appendTaskSteps") {
        // As Todofy appends them: steps under the parent, in entered order, listed by the next read.
        const steps = body.steps as Json[];
        const ids = steps.map(
          (_, index) =>
            `${String(body.parent_id)}-step-${state.tasks.length + index}`,
        );
        state.tasks.push(
          ...steps.map((item, index) => ({
            id: ids[index],
            kind: "step",
            title: item.title,
            parent_id: body.parent_id,
            area: "unassigned",
            stage: "none",
            explicit_stage: "none",
            planning_flags: [],
            etag: "1",
            ...(item.estimated_minutes
              ? { estimated_minutes: item.estimated_minutes }
              : {}),
          })),
        );
        return { json: { task_ids: ids } };
      }
      if (path === "/api/plus/v1/weeklyBets:setWeeklyBet") {
        const same = (bet: Json) =>
          bet.week_start === body.week_start && bet.area === body.area;
        const saved = state.bets.find(same) ?? {};
        if ((body.etag ?? "") !== (saved.etag ?? ""))
          return refusal(409, "ABORTED", "ETAG_MISMATCH");
        const bet = {
          week_start: body.week_start,
          area: body.area,
          text: body.text,
          etag: String(Number(saved.etag ?? 0) + 1),
        };
        state.bets = [...state.bets.filter((item) => !same(item)), bet];
        return { json: { weekly_bet: bet } };
      }
      if (path === "/api/plus/v1/tasks:setTaskDependency") {
        const same = (dependency: Json) =>
          dependency.task_id === body.task_id &&
          dependency.prerequisite_id === body.prerequisite_id;
        state.dependencies = [
          ...state.dependencies.filter((dependency) => !same(dependency)),
          ...(body.waits
            ? [{ task_id: body.task_id, prerequisite_id: body.prerequisite_id }]
            : []),
        ];
        return {
          json: {
            dependencies: state.dependencies.filter(
              (dependency) => dependency.task_id === body.task_id,
            ),
          },
        };
      }
      if (path === "/api/plus/v1/tasks:resolveDependencies") {
        // As Todofy settles them: a prerequisite that left the list was completed.
        for (const dependency of state.dependencies)
          if (
            (body.task_ids as string[]).includes(
              String(dependency.prerequisite_id),
            )
          )
            dependency.done = true;
        return { json: { dependencies: state.dependencies } };
      }
      if (path === "/api/plus/v1/mailItems")
        return {
          json: {
            mail_items: state.mail,
            categories: [],
            categories_etag: "1",
          },
        };
      if (path === "/api/plus/v1/mailItems:readMailSummary")
        return {
          json: {
            summary: state.summaries[url.searchParams.get("id") ?? ""] ?? "",
          },
        };
      if (path === "/api/plus/v1/mailItems:convertMailItem") {
        const item = state.mail.find((mail) => mail.id === body.event_id)!;
        state.mail = state.mail.filter((mail) => mail !== item);
        return {
          json: { task: { id: `task-${String(item.id)}`, title: item.title } },
        };
      }
      return undefined;
    };
    const response = await answer();
    await route.fulfill(
      response ?? {
        status: 500,
        json: { error: { message: `Unexpected synthetic request ${path}` } },
      },
    );
  });
  return state;
}

async function stillOpen(request: APIRequestContext, tasks: Json[]) {
  const open = await Promise.all(
    tasks.map(async (task) => {
      const saved = await request.get(`/api/tasks/v1/tasks/${String(task.id)}`);
      return !saved.ok() || !(await saved.json()).completed;
    }),
  );
  return tasks.filter((_, index) => open[index]);
}

/**
 * Creates a task in the dev server's own D1. Plan and Focus complete a task in Tasks (GetTask, then
 * CompleteTask, which settles its Focus day), so a journey that completes one needs it there.
 */
export async function createTask(
  request: APIRequestContext,
  task: Json,
): Promise<{ id: string; name: string; etag: string; title: string }> {
  const { token } = await (await request.get("/api/tasks/csrf")).json();
  const response = await request.post(
    `/api/tasks/v1/tasks?request_id=${crypto.randomUUID()}`,
    {
      headers: { "x-csrf-token": token, origin: "http://127.0.0.1:8798" },
      data: task,
    },
  );
  expect(response.status()).toBe(200);
  return response.json();
}

/** The dev server's own Tasks API as the owner, in a request context of its own, so the page's CSRF cookie stays. */
interface TasksApi {
  read(path: string): Promise<Json | undefined>;
  write(path: string, data: Json): Promise<Json>;
}
async function withTasks<T>(use: (api: TasksApi) => Promise<T>): Promise<T> {
  const context = await apiRequest.newContext({ baseURL: ORIGIN });
  try {
    const { token } = await (await context.get("/api/tasks/csrf")).json();
    return await use({
      async read(path) {
        const response = await context.get(path);
        if (response.status() === 404) return undefined;
        expect(response.status(), `GET ${path}`).toBe(200);
        return response.json();
      },
      async write(path, data) {
        const response = await context.post(path, {
          headers: { "x-csrf-token": token, origin: ORIGIN },
          data,
        });
        expect(response.status(), `POST ${path}`).toBe(200);
        return response.json();
      },
    });
  } finally {
    await context.dispose();
  }
}
const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T12:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
/** The Monday of a day's week, which a plan's `week_start` is. */
export function mondayOf(day: string): string {
  return addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
}
/** Tasks' today: the day Focus shows, the timer counts on and an empty focus_day settles. */
export async function tasksToday(): Promise<string> {
  return String((await readFocus("2026-01-05", "2026-01-05")).today);
}
/** ListFocusDays from the dev server, as its wire JSON. */
export async function readFocus(start: string, end: string): Promise<Json> {
  return withTasks(
    async (api) =>
      (await api.read(
        `/api/tasks/v1/focusDays?start_day=${start}&end_day=${end}`,
      ))!,
  );
}
/** The dev server's Focus timer, as its wire JSON. */
export async function readTimer(): Promise<Json> {
  return withTasks(
    async (api) => (await api.read("/api/tasks/v1/focusTimer"))!,
  );
}
/** Starts the dev server's timer on a task, counting up; it counts on Tasks' today. */
export async function startTimer(taskId: string): Promise<Json> {
  return withTasks(async (api) => {
    const timer = (await api.read("/api/tasks/v1/focusTimer"))!;
    return api.write("/api/tasks/v1/focusTimer:command", {
      request_id: crypto.randomUUID(),
      etag: timer.etag,
      action: "start",
      task_id: taskId,
    });
  });
}
/**
 * Puts the dev server's Focus in a known state, as a planning test begins: the timer stopped, and
 * every step (open or done) taken off the queues of `week`, of Tasks' today and of each seeded
 * day. Then each day of `queues` gets its steps, first to last. Each queued task, and each of
 * `inTasks`, is made in D1 when it is missing, under its own ID, titled as in `tasks`, and inside
 * one synthetic parent so the Inbox gains one row; a completed one is reopened.
 */
export async function seedFocus(
  queues: Record<string, string[]> = {},
  week = "2026-10-12",
  tasks: Json[] = [],
  inTasks: string[] = [],
): Promise<void> {
  await withTasks(async (api) => {
    const timer = (await api.read("/api/tasks/v1/focusTimer"))!;
    if (timer.state === "running" || timer.state === "paused")
      await api.write("/api/tasks/v1/focusTimer:command", {
        request_id: crypto.randomUUID(),
        etag: timer.etag,
        action: "stop",
      });
    const today = String(
      (await api.read(
        "/api/tasks/v1/focusDays?start_day=2026-01-05&end_day=2026-01-05",
      ))!.today,
    );
    const weeks = new Set(
      [week, today, ...Object.keys(queues)].map((day) => mondayOf(day)),
    );
    for (const monday of weeks) {
      const read = (await api.read(
        `/api/tasks/v1/focusDays?start_day=${monday}&end_day=${addDays(monday, 6)}`,
      ))!;
      for (const day of read.days as Json[])
        for (const id of [
          ...((day.task_ids as string[] | undefined) ?? []),
          ...((day.done_task_ids as string[] | undefined) ?? []),
        ])
          await api.write("/api/tasks/v1/focusDays:moveStep", {
            request_id: crypto.randomUUID(),
            task_id: id,
            source_day: day.day,
          });
    }
    const ids = [...new Set([...Object.values(queues).flat(), ...inTasks])];
    if (ids.length) await ensureTasks(api, ids, tasks);
    for (const [day, steps] of Object.entries(queues))
      for (const id of steps)
        await api.write("/api/tasks/v1/focusDays:moveStep", {
          request_id: crypto.randomUUID(),
          task_id: id,
          destination_day: day,
        });
  });
}
const SEEDS = "synthetic-planning-seeds";
async function ensureTasks(api: TasksApi, ids: string[], tasks: Json[]) {
  const create = (id: string, data: Json) =>
    api.write(
      `/api/tasks/v1/tasks?task_id=${id}&request_id=${crypto.randomUUID()}`,
      data,
    );
  if (!(await api.read(`/api/tasks/v1/tasks/${SEEDS}`)))
    await create(SEEDS, { title: "Synthetic planning seeds" });
  for (const id of ids) {
    const saved = await api.read(`/api/tasks/v1/tasks/${id}`);
    const title = tasks.find((task) => task.id === id)?.title ?? id;
    if (!saved) await create(id, { title, parent_id: SEEDS });
    else if (saved.completed)
      await api.write(`/api/tasks/v1/tasks/${id}:reopen`, {
        etag: saved.etag,
        request_id: crypto.randomUUID(),
      });
  }
}
