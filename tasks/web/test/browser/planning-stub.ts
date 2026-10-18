import type { Page } from "@playwright/test";

export type Json = Record<string, unknown>;
export interface PlanningRequest {
  path: string;
  method: string;
  body: Json;
  authorization: string | null;
}
/** What the synthetic Todofy planning API and FlowDay hold; tests read and change it in place. */
export interface PlanningState {
  today: string;
  /** Plan fields over the defaults (a native plan for the week of 2026-10-12). */
  plan: Json;
  tasks: Json[];
  /** FlowDay's task list: mirrored tasks carry `todoist_id`. */
  flowTasks: Json[];
  /** FlowDay's day queues by date. */
  days: Record<string, string[]>;
  timer: Json;
  bets: Json[];
  dependencies: Json[];
  mail: Json[];
  summaries: Record<string, string>;
  requests: PlanningRequest[];
}

const FLOWDAY = "/api/plus/flowday/api/v1/";

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
 * Answers `/api/plus/**` in the page as Todofy's planning API and FlowDay's focus API do for
 * Tasks, from synthetic data only. Every request is recorded; an unknown one fails with 500.
 */
export async function stubPlanning(
  page: Page,
  seed: Partial<Omit<PlanningState, "requests">> = {},
): Promise<PlanningState> {
  const state: PlanningState = {
    today: "2026-10-13",
    plan: {},
    tasks: [],
    flowTasks: [],
    days: {},
    timer: { name: "timerSession", state: "idle", etag: "0" },
    bets: [],
    dependencies: [],
    mail: [],
    summaries: {},
    requests: [],
    ...seed,
  };
  const flow = (date: string) => ({
    name: `flows/${date}`,
    task_ids: state.days[date] ?? [],
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
    const answer = (): { status?: number; json: unknown } | undefined => {
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
        return { json: { planning_tasks: state.tasks } };
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
      if (path === "/api/plus/v1/tasks:completeTask") {
        state.tasks = state.tasks.filter((item) => item.id !== body.task_id);
        return { json: { task_id: body.task_id } };
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
      if (path === `${FLOWDAY}tasks`)
        return { json: { tasks: state.flowTasks } };
      if (path === `${FLOWDAY}timerSession`) return { json: state.timer };
      if (path === `${FLOWDAY}timerSession:command`) {
        const running = body.action === "start" || body.action === "resume";
        state.timer = running
          ? {
              name: "timerSession",
              task_id: body.task_id,
              flow_date: body.flow_date,
              state: "running",
              segment_start_time: `${state.today}T18:00:00Z`,
              etag: String(Number(state.timer.etag) + 1),
            }
          : {
              ...state.timer,
              state: body.action === "pause" ? "paused" : "idle",
              etag: String(Number(state.timer.etag) + 1),
            };
        return { json: state.timer };
      }
      const flowMatch =
        /^\/api\/plus\/flowday\/api\/v1\/flows\/(\d{4}-\d{2}-\d{2})(:rollover)?$/u.exec(
          path,
        );
      if (flowMatch) {
        const date = flowMatch[1]!;
        if (flowMatch[2]) {
          const target = String(body.destination).slice("flows/".length);
          const moved = (body.task_ids as string[]).filter((id) =>
            state.days[date]?.includes(id),
          );
          state.days[target] = [
            ...moved.filter((id) => !state.days[target]?.includes(id)),
            ...(state.days[target] ?? []),
          ];
          state.days[date] = (state.days[date] ?? []).filter(
            (id) => !moved.includes(id),
          );
          return { json: { flow: flow(date), destination_flow: flow(target) } };
        }
        if (method === "PATCH")
          state.days[date] = [...(body.task_ids as string[])];
        return { json: flow(date) };
      }
      return undefined;
    };
    const response = answer();
    await route.fulfill(
      response ?? {
        status: 500,
        json: { error: { message: `Unexpected synthetic request ${path}` } },
      },
    );
  });
  return state;
}

/** FlowDay calls Tasks must never make: its own task sync and task writes. */
export function flowdayTaskWrites(state: PlanningState) {
  return state.requests.filter(
    (request) =>
      request.path.startsWith(`${FLOWDAY}tasks`) &&
      (request.path.endsWith(":sync") || request.method !== "GET"),
  );
}
