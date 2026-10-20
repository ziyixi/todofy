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
/** A task as a test seeds it in the dev server's D1, by its own ID, with its planning facts. */
export interface SeedTask {
  id: string;
  title: string;
  kind?: "task" | "step";
  parent_id?: string;
  /** The saved stage; Plan's lane comes from it and the dates (Task.board_stage). */
  stage?: string;
  area?: string;
  planning_flags?: string[];
  deadline?: string;
  lead_days?: number;
  due_date?: string;
  duration_minutes?: number;
  /** Tasks' order: 1 is P1. */
  priority?: number;
  sort_order?: number;
  /** The tasks it waits for, by ID. */
  dependencies?: string[];
  /** When Plan's list says it last changed; D1 sets the real time on every write. */
  update_time?: string;
}
/** What a planning test runs on: its tasks in D1, Tasks' today, and every request the page sent. */
export interface PlanningState {
  /** Tasks' today and its week's Monday, by the dev server's clock. */
  today: string;
  week: string;
  /** Synthetic Mail that Todofy keeps; tests change it in place. */
  mail: Json[];
  summaries: Record<string, string>;
  /** The page's requests to Todofy's `/api/plus/**`, which this module answers. */
  requests: PlanningRequest[];
  /** The page's requests to the dev server's own Tasks API. */
  tasksRequests: PlanningRequest[];
}
export interface PlanningSeed {
  tasks?: SeedTask[];
  /** This and next week's Bets; every other Bet of those weeks is cleared first. */
  bets?: { week_start: string; area: string; text: string }[];
  /** Review lanes' orders; every arranged lane is cleared first. */
  laneOrders?: { lane: string; task_ids: string[] }[];
  mail?: Json[];
  summaries?: Record<string, string>;
  /** The weekly review's two Todofy facts. */
  review?: { review_task_id?: string; mailbox_pending_count?: number };
  /** Day queues of seeded tasks, put in the dev server's D1 through MoveFocusStep, first to last. */
  queues?: Record<string, string[]>;
}

const ORIGIN = "http://127.0.0.1:8798";
/** The synthetic project seeded tasks live in, so the Inbox stays as other specs left it. */
const PROJECT = "synthetic-planning";
const LANES = [
  "start",
  "waiting",
  "parked",
  "quarterly",
  "monthly",
  "weekly",
  "committed",
];
/** The fields a seed writes; a seeded task that exists already takes them again. */
const SEEDED: readonly (keyof SeedTask)[] = [
  "title",
  "kind",
  "parent_id",
  "stage",
  "area",
  "planning_flags",
  "deadline",
  "lead_days",
  "due_date",
  "duration_minutes",
  "priority",
  "sort_order",
];

/**
 * Plan and Focus run on the dev server's own Tasks API and D1, as in production: this seeds a test's
 * tasks there with their planning facts, dependencies, Bets, lane orders and Focus queues, all
 * through the API. Each seeded task keeps its ID across tests: one that exists already is reopened
 * and written again. The dev server's D1 is shared by every spec, so Plan's list of open tasks is
 * narrowed to the seeded ones, as a fresh database would hold them. Only Todofy's half is
 * synthetic: the weekly review's two facts and Mail (`/api/plus/**`); an unknown request fails with
 * 500. Every request is recorded.
 */
export async function stubPlanning(
  page: Page,
  {
    tasks = [],
    bets = [],
    laneOrders = [],
    queues = {},
    review = {},
    ...seed
  }: PlanningSeed = {},
): Promise<PlanningState> {
  const today = await tasksToday();
  const state: PlanningState = {
    today,
    week: mondayOf(today),
    mail: seed.mail ?? [],
    summaries: seed.summaries ?? {},
    requests: [],
    tasksRequests: [],
  };
  await withTasks(async (api) => {
    const plan = (await api.read("/api/tasks/v1/plan"))!;
    for (const order of (plan.lane_orders as Json[] | undefined) ?? [])
      if (LANES.includes(String(order.lane)))
        await api.write("/api/tasks/v1/tasks:reorder", {
          positions: [],
          request_id: crypto.randomUUID(),
          lane_order: { lane: order.lane, task_ids: [] },
        });
    for (const bet of (plan.weekly_bets as Json[] | undefined) ?? [])
      if (bet.text && bet.week_start !== addDays(state.week, -7))
        await api.patch(
          `/api/tasks/v1/${String(bet.name)}?update_mask=text&etag=${String(bet.etag)}`,
          {
            text: "",
          },
        );
    if (tasks.length) await ensureProject(api);
    for (const task of tasks) await upsert(api, task);
    for (const task of tasks) {
      const saved = (await api.read(`/api/tasks/v1/tasks/${task.id}`))!;
      const wanted = task.dependencies ?? [];
      if (wanted.length || (saved.dependencies as Json[] | undefined)?.length)
        await api.patch(
          `/api/tasks/v1/tasks/${task.id}?etag=${String(saved.etag)}&request_id=${crypto.randomUUID()}&update_mask=dependencies`,
          { dependencies: wanted.map((id) => ({ prerequisite_id: id })) },
        );
    }
    for (const bet of bets) {
      const name = `weeklyBets/${bet.week_start}-${bet.area}`;
      const current = (await api.read("/api/tasks/v1/plan"))!.weekly_bets as
        Json[] | undefined;
      const etag = current?.find((saved) => saved.name === name)?.etag ?? "";
      await api.patch(
        `/api/tasks/v1/${name}?update_mask=text&etag=${String(etag)}`,
        { text: bet.text },
      );
    }
    for (const order of laneOrders)
      await api.write("/api/tasks/v1/tasks:reorder", {
        positions: [],
        request_id: crypto.randomUUID(),
        lane_order: order,
      });
  });
  await seedFocus(queues);
  const seeded = new Set(tasks.map((task) => task.id));
  const aged = new Map(
    tasks.flatMap((task) =>
      task.update_time ? [[task.id, task.update_time]] : [],
    ),
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
  // Plan's ListTasks pages (view=all, no IDs and no search) list only this test's tasks and the
  // ones the page adds under them, with the seeded ages.
  await page.route("**/api/tasks/v1/tasks?*", async (route) => {
    const url = new URL(route.request().url());
    if (
      route.request().method() !== "GET" ||
      url.searchParams.get("view") !== "all" ||
      url.searchParams.has("task_ids") ||
      url.searchParams.get("query")
    )
      return route.fallback();
    const response = await route.fetch();
    const listed = (await response.json()) as { tasks?: Json[] };
    const kept = new Set(seeded);
    for (let grown = true; grown;) {
      grown = false;
      for (const task of listed.tasks ?? [])
        if (!kept.has(String(task.id)) && kept.has(String(task.parent_id))) {
          kept.add(String(task.id));
          grown = true;
        }
    }
    await route.fulfill({
      response,
      json: {
        ...listed,
        tasks: (listed.tasks ?? [])
          .filter((task) => kept.has(String(task.id)))
          .map((task) => ({
            ...task,
            update_time: aged.get(String(task.id)) ?? task.update_time,
          })),
      },
    });
  });
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
    const answer = (): { status?: number; json: unknown } | undefined => {
      if (path === "/api/plus/v1/weeklyReview:read")
        return {
          json: { mailbox_pending_count: state.mail.length, ...review },
        };
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
    await route.fulfill(
      answer() ?? {
        status: 500,
        json: { error: { message: `Unexpected synthetic request ${path}` } },
      },
    );
  });
  return state;
}

async function ensureProject(api: TasksApi) {
  const catalog = (await api.read("/api/tasks/v1/catalog"))!;
  if (
    !(catalog.projects as Json[] | undefined)?.some(
      (project) => project.id === PROJECT,
    )
  )
    await api.write(
      `/api/tasks/v1/projects?project_id=${PROJECT}&request_id=${crypto.randomUUID()}`,
      {
        title: "Synthetic planning",
      },
    );
}

/** How many times the page read GetPlan. */
export function planReads(state: PlanningState): number {
  return state.tasksRequests.filter(
    (request) =>
      request.method === "GET" && request.path === "/api/tasks/v1/plan",
  ).length;
}

/** Writes a seeded task in D1 under its own ID: created, or reopened and written again. */
async function upsert(api: TasksApi, task: SeedTask) {
  const id = task.id;
  const fields = Object.fromEntries(
    SEEDED.flatMap((key) =>
      task[key] === undefined ? [] : [[key, task[key]]],
    ),
  );
  // A step's project is its parent's.
  const top = !task.parent_id;
  const values: Json = {
    kind: "task",
    ...(top ? { project_id: PROJECT } : {}),
    stage: "none",
    area: "unassigned",
    planning_flags: [],
    ...fields,
  };
  let saved = await api.read(`/api/tasks/v1/tasks/${id}`);
  if (!saved) {
    await api.write(
      `/api/tasks/v1/tasks?task_id=${id}&request_id=${crypto.randomUUID()}`,
      values,
    );
    return;
  }
  if (saved.completed)
    saved = await api.write(`/api/tasks/v1/tasks/${id}:reopen`, {
      etag: saved.etag,
      request_id: crypto.randomUUID(),
    });
  const mask = [
    ...SEEDED.filter(
      (field) => field !== "sort_order" || "sort_order" in values,
    ),
    ...(top ? ["project_id"] : []),
  ];
  await api.patch(
    `/api/tasks/v1/tasks/${id}?etag=${String(saved.etag)}&request_id=${crypto.randomUUID()}&update_mask=${mask.join(",")}`,
    {
      title: "",
      parent_id: "",
      deadline: "",
      lead_days: 0,
      due_date: "",
      duration_minutes: 0,
      priority: 4,
      ...values,
    },
  );
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
  patch(path: string, data: Json): Promise<Json>;
  remove(path: string): Promise<void>;
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
      async patch(path, data) {
        const response = await context.patch(path, {
          headers: { "x-csrf-token": token, origin: ORIGIN },
          data,
        });
        expect(
          response.status(),
          `PATCH ${path}: ${await response.text()}`,
        ).toBe(200);
        return response.json();
      },
      async remove(path) {
        const response = await context.delete(path, {
          headers: { "x-csrf-token": token, origin: ORIGIN },
        });
        expect(response.status(), `DELETE ${path}`).toBe(200);
      },
    });
  } finally {
    await context.dispose();
  }
}
export const addDays = (day: string, days: number) =>
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
/** The days of `today`'s week other than today, Monday first. */
export function otherDays(today: string): string[] {
  const week = mondayOf(today);
  return [0, 1, 2, 3, 4, 5, 6]
    .map((offset) => addDays(week, offset))
    .filter((day) => day !== today);
}
/** GetPlan from the dev server, as its wire JSON. */
export async function readPlan(): Promise<Json> {
  return withTasks(async (api) => (await api.read("/api/tasks/v1/plan"))!);
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
/** Adds time to a task on a day in the dev server's D1, as Focus's records do. */
export async function addRecord(
  taskId: string,
  day: string,
  minutes: number,
  area: "" | "work" | "personal" = "",
): Promise<Json> {
  return withTasks((api) =>
    api.write(`/api/tasks/v1/focusEntries?request_id=${crypto.randomUUID()}`, {
      task_id: taskId,
      day,
      seconds: minutes * 60,
      area,
    }),
  );
}
/**
 * Puts the dev server's Focus in a known state, as a planning test begins: the timer stopped, and
 * every step (open or done) taken off the queues of Tasks' today's week and of each seeded day's,
 * with those weeks' time records deleted. Then each day of `queues` gets its steps, first to last.
 */
async function seedFocus(queues: Record<string, string[]>): Promise<void> {
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
      [today, ...Object.keys(queues)].map((day) => mondayOf(day)),
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
      for (const entry of (read.entries as Json[] | undefined) ?? [])
        await api.remove(
          `/api/tasks/v1/${String(entry.name)}?etag=${String(entry.etag)}&request_id=${crypto.randomUUID()}`,
        );
    }
    for (const [day, steps] of Object.entries(queues))
      for (const id of steps)
        await api.write("/api/tasks/v1/focusDays:moveStep", {
          request_id: crypto.randomUUID(),
          task_id: id,
          destination_day: day,
        });
  });
}
