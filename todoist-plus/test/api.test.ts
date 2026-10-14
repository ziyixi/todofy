import { expect, it, vi } from "vitest";
import { createApi, publicError, validOrigin } from "../src/api";
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
      return json({ name: "timerSession", state: "running", etag: "43" });
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
  await api.timer("start", "child", focus);
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
        return json({ name: "flows/2026-10-13", task_ids: ["new-child"] });
      return json({ name: "tasks/new-child", title: "New synthetic child" });
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
  await api.updateQueue(["new-child"], focus);
  expect(calls[0]?.path).toBe("/api/plus/flowday/api/v1/tasks:sync");
  expect(calls[0]?.body).toEqual({ mode: "manual" });
  expect(calls[1]?.body).toEqual({ mode: "manual" });
  expect(calls[2]).toMatchObject({
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
