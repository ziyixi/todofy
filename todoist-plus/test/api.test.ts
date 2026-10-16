import { expect, it, vi } from "vitest";
import { createApi, publicError, validOrigin } from "../src/api";
import { Code, RpcError, statusBody } from "@ziyixi/proto/rpc-status";
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
it("loads complete pages and uses the authoritative timer etag for subsequent actions", async () => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer synthetic-token",
    );
    expect(init?.credentials).toBe("omit");
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    calls.push({ path: url.pathname + url.search, body });
    if (url.pathname === "/api/plus/v1/plan:read")
      return json({
        plan: {
          timezone: "UTC",
          week_start: "2026-10-12",
          today: "2026-10-13",
          enabled: true,
        },
      });
    if (url.pathname === "/api/plus/v1/tasks")
      return url.searchParams.get("page_token")
        ? json({
            planning_tasks: [
              {
                id: "child",
                title: "A small step",
                parent_id: "parent",
                stage: "none",
                area: "work",
              },
            ],
          })
        : json({
            planning_tasks: [
              {
                id: "parent",
                title: "A project",
                stage: "committed",
                area: "work",
              },
            ],
            next_page_token: "second",
          });
    if (url.pathname.endsWith("/flows/2026-10-13"))
      return json({ name: "flows/2026-10-13", task_ids: ["child"] });
    if (url.pathname.includes("/flows/"))
      return json({ name: `flows/${url.pathname.split("/").at(-1)}` });
    if (url.pathname.endsWith("/timerSession"))
      return json({ name: "timerSession", state: "idle", etag: "42" });
    if (url.pathname.endsWith("/tasks"))
      return json({
        tasks: [
          {
            name: "tasks/child",
            todoist_id: "child",
            title: "A small step",
            estimated_minutes: 45,
          },
        ],
      });
    if (url.pathname.endsWith("/timerSession:command"))
      return json({
        name: "timerSession",
        task_id: "child",
        flow_date: "2026-10-13",
        state: "running",
        etag: "43",
        saved_seconds: 5,
        segment_start_time: "2026-10-13T12:00:00Z",
      });
    if (url.pathname.endsWith(":completeTask"))
      return json({ task_id: "child" });
    throw new Error("Unexpected request " + url.pathname);
  });
  const api = createApi(
    { apiOrigin: "https://api.example.test", token: "synthetic-token" },
    fetcher,
  );
  const { plan, focus, days } = await api.load();
  expect(days.map((day) => day.date)).toEqual([
    "2026-10-12",
    "2026-10-13",
    "2026-10-14",
    "2026-10-15",
    "2026-10-16",
    "2026-10-17",
    "2026-10-18",
  ]);
  expect(plan.tasks.map((task) => task.id)).toEqual(["parent", "child"]);
  expect(focus.estimates.child).toBe(45);
  expect(focus.timerEtag).toBe("42");
  const timerCallsStart = calls.length;
  const confirmed = await api.timer("start", "child", focus);
  expect(confirmed).toEqual({
    timerEtag: "43",
    timer: {
      taskId: "child",
      flowDate: "2026-10-13",
      status: "running",
      elapsedSeconds: 5,
      startedAt: "2026-10-13T12:00:00.000Z",
      etag: "43",
    },
  });
  expect(calls.slice(timerCallsStart)).toHaveLength(1);
  const command = calls.find((call) => call.path.endsWith(":command"))!;
  expect(command.body.etag).toBe("42");
  expect(command.body.action).toBe("start");
  await api.completeTask(
    plan.tasks[1]!,
    "d4a3e34e-54c9-48c0-9996-98a4f72bef74",
    focus.date,
  );
  expect(calls.at(-1)?.body).toMatchObject({
    task_id: "child",
    flow_date: "2026-10-13",
    request_id: "d4a3e34e-54c9-48c0-9996-98a4f72bef74",
  });
  expect(calls.filter((call) => call.path.endsWith(":command")).length).toBe(1);

  const futureCallsStart = calls.length;
  const future = await api.load("2026-10-19");
  expect(future.plan.week).toBe("2026-10-12");
  expect(future.days.map((day) => day.date)).toEqual([
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
    "2026-10-23",
    "2026-10-24",
    "2026-10-25",
  ]);
  expect(future.focus.date).toBe("2026-10-13");
  expect(future.focus.taskIds).toEqual(["child"]);
  expect(
    calls
      .slice(futureCallsStart)
      .filter((call) => call.path.includes("/flows/"))
      .map((call) => call.path.split("/").at(-1))
      .sort(),
  ).toEqual(["2026-10-13", ...future.days.map((day) => day.date)]);
});
it("reads only the selected week's seven queues when changing weeks", async () => {
  const paths: string[] = [];
  const api = createApi(
    { apiOrigin: "https://api.example.test", token: "synthetic" },
    vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (!path.includes("/flows/"))
        throw new Error(
          "Week selection must not scan tasks or account metadata",
        );
      return json({
        name: `flows/${path.split("/").at(-1)}`,
        task_ids: ["synthetic-step"],
        completed_task_ids: ["synthetic-completed"],
      });
    }),
  );
  const days = await api.loadDays("2026-10-19");
  expect(paths).toHaveLength(7);
  expect(days.map((day) => day.date)).toEqual([
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
    "2026-10-23",
    "2026-10-24",
    "2026-10-25",
  ]);
  expect(days.every((day) => day.taskIds[0] === "synthetic-step")).toBe(true);
  expect(
    days.every((day) => day.completedTaskIds[0] === "synthetic-completed"),
  ).toBe(true);
});
it("returns a confirmed stopped timer without reloading the task lists", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    expect(new URL(String(input)).pathname).toBe(
      "/api/plus/flowday/api/v1/timerSession:command",
    );
    return json({ name: "timerSession", state: "idle", etag: "44" });
  });
  const api = createApi(
    { apiOrigin: "https://api.example.test", token: "synthetic" },
    fetcher,
  );
  const confirmed = await api.timer("stop", "child", {
    date: "2026-10-13",
    timerEtag: "43",
    taskIds: ["child"],
    completedTaskIds: [],
    estimates: {},
    flowTasks: {},
  });
  expect(confirmed).toEqual({ timerEtag: "44" });
  expect(confirmed.timer).toBeUndefined();
  expect(fetcher).toHaveBeenCalledOnce();
});
it("rejects connection origins with paths, credentials or insecure protocols", () => {
  for (const value of [
    "http://example.test",
    "https://user:password@example.test",
    "https://example.test/api",
    "https://example.test/?token=x",
  ])
    expect(() => validOrigin(value)).toThrow();
  expect(validOrigin("https://example.test/")).toBe("https://example.test");
});
it("does not present partial task pages as a complete plan", async () => {
  const api = createApi(
    { apiOrigin: "https://api.example.test", token: "synthetic" },
    vi.fn<typeof fetch>(async (input) =>
      String(input).includes("/plan:read")
        ? json({ plan: { today: "2026-10-13" } })
        : json({ next_page_token: "more" }),
    ),
  );
  await expect(api.load()).rejects.toThrow("incomplete");
});
it("manually finishes a partial sync before queueing or estimating new Todoist children", async () => {
  let syncCount = 0;
  const calls: {
    path: string;
    mask: string | null;
    body: Record<string, unknown>;
  }[] = [];
  const api = createApi(
    { apiOrigin: "https://api.example.test", token: "synthetic" },
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      calls.push({
        path: url.pathname,
        mask: url.searchParams.get("update_mask"),
        body: init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : {},
      });
      if (url.pathname.endsWith("/tasks:sync")) {
        syncCount++;
        return json({ state: syncCount === 1 ? "partial" : "synced" });
      }
      if (url.pathname.includes("/flows/"))
        return json({
          name: "flows/2026-10-13",
          task_ids: init?.method === "PATCH" ? ["new-child"] : [],
        });
      return json({ name: "tasks/new-child", title: "New synthetic child" });
    }),
  );
  await api.addToDay("new-child", "2026-10-13");
  expect(calls[0]?.path).toBe("/api/plus/flowday/api/v1/tasks:sync");
  expect(calls[0]?.body).toEqual({ mode: "manual" });
  expect(calls[1]?.body).toEqual({ mode: "manual" });
  expect(calls[3]).toMatchObject({
    mask: "task_ids",
    body: { task_ids: ["new-child"] },
  });
  await api.updateEstimate("new-child", 45);
  expect(calls.at(-1)).toMatchObject({
    mask: "estimated_minutes",
    body: { estimated_minutes: 45 },
  });
});
it("replays an uncertain timer command with the same UUID until acknowledged", async () => {
  const ids: string[] = [];
  const api = createApi(
    { apiOrigin: "https://api.example.test", token: "synthetic" },
    vi.fn<typeof fetch>(async (_input, init) => {
      ids.push(
        (JSON.parse(String(init?.body)) as { request_id: string }).request_id,
      );
      if (ids.length === 1) throw new TypeError("Synthetic response loss");
      return json({ name: "timerSession", state: "running", etag: "1" });
    }),
  );
  const focus = {
    date: "2026-10-13",
    timerEtag: "0",
    taskIds: [],
    completedTaskIds: [],
    estimates: {},
    flowTasks: {},
  };
  await expect(api.timer("start", "child", focus)).rejects.toThrow();
  await api.timer("start", "child", focus);
  expect(ids[0]).toBe(ids[1]);
});
it("keeps a cleared FlowDay estimate unknown and resumes a timer on its original day", async () => {
  let command: Record<string, unknown> = {};
  const api = createApi(
    { apiOrigin: "https://api.example.test", token: "synthetic" },
    vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/plan:read"))
        return json({
          plan: {
            timezone: "UTC",
            week_start: "2026-10-12",
            today: "2026-10-13",
            enabled: true,
          },
        });
      if (path === "/api/plus/v1/tasks")
        return json({
          planning_tasks: [
            { id: "child", title: "Synthetic step", estimated_minutes: 60 },
          ],
        });
      if (path.endsWith("/flows/2026-10-13"))
        return json({ name: "flows/2026-10-13", task_ids: ["child"] });
      if (path.includes("/flows/"))
        return json({ name: `flows/${path.split("/").at(-1)}` });
      if (path.endsWith("/timerSession"))
        return json({
          name: "timerSession",
          task_id: "child",
          state: "paused",
          flow_date: "2026-10-12",
          etag: "3",
        });
      if (path.endsWith("/tasks"))
        return json({
          tasks: [
            {
              name: "tasks/child",
              todoist_id: "child",
              title: "Synthetic step",
            },
          ],
        });
      command = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ name: "timerSession", state: "running", etag: "4" });
    }),
  );
  const { plan, focus } = await api.load();
  expect(plan.tasks[0]?.estimatedMinutes).toBeUndefined();
  expect(focus.timer?.flowDate).toBe("2026-10-12");
  await api.timer("resume", "child", focus);
  expect(command.flow_date).toBe("2026-10-12");
});

it("shows an actionable throttled sync and does not attempt the following write", async () => {
  const paths: string[] = [];
  const api = createApi(
    { apiOrigin: "https://api.example.test", token: "synthetic" },
    vi.fn<typeof fetch>(async (input) => {
      paths.push(new URL(String(input)).pathname);
      return json({ state: "throttled" });
    }),
  );
  let failure: unknown;
  try {
    await api.updateEstimate("new-child", 30);
  } catch (error) {
    failure = error;
  }
  expect(publicError(failure)).toBe(
    "FlowDay just synced. Wait briefly and try adding or estimating this task again.",
  );
  expect(paths).toEqual(["/api/plus/flowday/api/v1/tasks:sync"]);
});

it("names a token the gateway refuses as an expired connection, so the cached sidebar is dropped", async () => {
  // What the gateway's plusExtension answers for an unknown or revoked token.
  const body = statusBody(
    new RpcError(
      Code.UNAUTHENTICATED,
      "UNAUTHORIZED",
      "no valid Cloudflare Access login for the owner",
    ),
    { domain: "todofy.ziyixi.science" },
  );
  const api = createApi(
    { apiOrigin: "https://api.example.test", token: "synthetic" },
    vi.fn<typeof fetch>(async () => Response.json(body, { status: 401 })),
  );
  const failure = await api.readPlan().catch((error: unknown) => error);
  expect(publicError(failure)).toBe(
    "Connection expired or revoked. Open connection settings.",
  );
});

it("returns the confirmed lead task and label plan instead of requiring a full reload", async () => {
  const paths: string[] = [];
  const api = createApi(
    { apiOrigin: "https://api.example.test", token: "synthetic" },
    vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path.endsWith("/tasks:setTaskLead"))
        return json({
          task: {
            id: "child",
            title: "Synthetic step",
            stage: "weekly",
            deadline: "2026-10-30",
            lead_days: 7,
            etag: "child-2",
            estimated_minutes: 480,
          },
        });
      if (path.endsWith("/plan:updatePlanLabels"))
        return json({
          plan: {
            timezone: "UTC",
            week_start: "2026-10-12",
            today: "2026-10-13",
            enabled: true,
            etag: "plan-2",
            labels: [{ role: "committed", id: "l9", label: "now" }],
            hidden_filter_ids: ["f1"],
          },
        });
      throw new Error("Unexpected request " + path);
    }),
  );
  const lead = await api.updateLead(
    {
      id: "child",
      title: "Synthetic step",
      parentId: "",
      projectId: "",
      labels: [],
      area: "work",
      stage: "weekly",
      priority: 1,
      deadline: "",
      due: "",
      leadDays: 0,
      estimatedMinutes: 30,
      etag: "child-1",
      mustStart: false,
      missingLead: false,
    },
    "2026-10-30",
    7,
  );
  expect(lead).toMatchObject({
    id: "child",
    deadline: "2026-10-30",
    leadDays: 7,
    etag: "child-2",
    // FlowDay's manual estimate stays authoritative over Todoist's duration.
    estimatedMinutes: 30,
  });
  const plan = await api.updateLabels(
    [{ role: "committed", id: "l9", label: "now" }],
    "plan-1",
  );
  expect(plan).toMatchObject({
    etag: "plan-2",
    configured: true,
    hiddenFilterIds: ["f1"],
    managedLabels: [{ role: "committed", id: "l9", label: "now" }],
  });
  expect(plan).not.toHaveProperty("tasks");
  expect(paths).toEqual([
    "/api/plus/v1/tasks:setTaskLead",
    "/api/plus/v1/plan:updatePlanLabels",
  ]);
});

it("remembers synced FlowDay tasks across writes and worker restarts, storing IDs only", async () => {
  const requests: string[] = [];
  let synced = false;
  // FlowDay allows one manual sync per 30 seconds; a second one is throttled.
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname.endsWith("/tasks:sync")) {
      const state = synced ? "throttled" : "synced";
      synced = true;
      return json({ state });
    }
    if (url.pathname.includes("/flows/"))
      return json({ name: "flows/2026-10-13", task_ids: ["new-child"] });
    return json({ name: "tasks/new-child", title: "New synthetic child" });
  });
  let saved: string[] = [];
  const store = {
    read: vi.fn(async () => saved),
    write: vi.fn(async (ids: string[]) => {
      saved = ids;
    }),
  };
  const focus = {
    date: "2026-10-13",
    timerEtag: "0",
    taskIds: [],
    completedTaskIds: [],
    estimates: {},
    flowTasks: {},
  };
  const connection = {
    apiOrigin: "https://api.example.test",
    token: "synthetic",
  };
  const api = createApi(connection, fetcher, store);
  await api.addToDay("new-child", focus.date);
  await api.updateEstimate("new-child", 30);
  await api.moveTaskToDay("new-child", undefined, focus);
  expect(requests.filter((request) => request.endsWith(":sync"))).toHaveLength(
    1,
  );
  expect(saved).toEqual(["new-child"]);

  // A restarted worker creates a new client; the session copy still skips the sync.
  const restarted = createApi(connection, fetcher, store);
  const start = requests.length;
  await restarted.updateEstimate("new-child", 45);
  expect(requests.slice(start)).toEqual([
    "PATCH /api/plus/flowday/api/v1/tasks/new-child",
  ]);
});

it("replaces the remembered tasks with the complete FlowDay list on each load", async () => {
  let saved = ["deleted-task"];
  const api = createApi(
    { apiOrigin: "https://api.example.test", token: "synthetic" },
    vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/plan:read"))
        return json({
          plan: { week_start: "2026-10-12", today: "2026-10-13" },
        });
      if (path === "/api/plus/v1/tasks") return json({});
      if (path.endsWith("/api/v1/tasks"))
        return json({
          tasks: [
            { name: "tasks/child", todoist_id: "child", title: "Synthetic" },
          ],
        });
      if (path.endsWith("/timerSession"))
        return json({ name: "timerSession", etag: "1" });
      return json({ name: `flows/${path.split("/").at(-1)}` });
    }),
    {
      read: async () => saved,
      write: async (ids) => {
        saved = ids;
      },
    },
  );
  await api.load();
  expect(saved).toEqual(["child"]);
});
