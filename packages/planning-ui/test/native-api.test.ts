import { expect, it } from "vitest";
import { createPlanningActions } from "../src/api";
import type { HttpCall, HttpSend } from "@ziyixi/proto/http-client";

it("reads the native pending Mail count even when no mail task exists", async () => {
  const send: HttpSend = async () =>
    Response.json({
      plan: { enabled: true, native_planning: true, mailbox_pending_count: 0 },
    });
  const actions = createPlanningActions({ plus: send, flowday: send });
  expect(await actions.readPlan()).toMatchObject({
    mailboxPendingCount: 0,
  });
});

it("starts a FlowDay pomodoro and uses the authoritative session across pause, reload and finish", async () => {
  const calls: HttpCall[] = [];
  const send: HttpSend = async (call) => {
    calls.push(call);
    const body = call.body ? JSON.parse(call.body) : {};
    return Response.json(
      body.action === "finish_pomodoro"
        ? { name: "timerSession", state: "idle", etag: "finished" }
        : {
            name: "timerSession",
            state: "running",
            etag: "new-version",
            task_id: "step",
            flow_date: "2026-10-17",
            mode: "pomodoro",
            pomodoro_target_seconds: 1500,
            saved_seconds: 60,
            segment_start_time: "2026-10-17T12:00:00Z",
          },
    );
  };
  const api = createPlanningActions({ plus: send, flowday: send });
  const focus: import("../src/model").FocusState = {
    date: "2026-10-17",
    taskIds: ["step"],
    completedTaskIds: [],
    timerEtag: "0",
    estimates: {},
    flowTasks: {},
  };
  const started = await api.timer("start", "step", focus, 1500);
  expect(JSON.parse(calls[0]!.body!)).toMatchObject({
    etag: "0",
    action: "start",
    mode: "pomodoro",
    target_seconds: 1500,
  });
  expect(started.timer).toMatchObject({
    mode: "pomodoro",
    targetSeconds: 1500,
    elapsedSeconds: 60,
  });
  expect(await api.readTimer!()).toEqual(started);
  const finished = await api.timer("finish", "step", { ...focus, ...started });
  expect(JSON.parse(calls.at(-1)!.body!)).toMatchObject({
    etag: "new-version",
    action: "finish_pomodoro",
    flow_date: "2026-10-17",
  });
  expect(finished).toEqual({ timerEtag: "finished" });
});

it("keeps native step estimates canonical while the FlowDay cache is catching up", async () => {
  const send: HttpSend = async ({ url }) => {
    const path = url.split("?")[0]!;
    if (path === "/api/plus/v1/plan:read")
      return Response.json({
        plan: {
          enabled: true,
          native_planning: true,
          timezone: "UTC",
          today: "2026-10-17",
          week_start: "2026-10-12",
        },
      });
    if (path === "/api/plus/v1/tasks")
      return Response.json({
        planning_tasks: [{ id: "step", kind: "step", estimated_minutes: 90 }],
      });
    if (path === "/api/v1/tasks")
      return Response.json({
        tasks: [
          {
            name: "tasks/step",
            title: "Synthetic step",
            todoist_id: "step",
            estimated_minutes: 30,
          },
        ],
      });
    if (path.startsWith("/api/v1/flows/"))
      return Response.json({
        name: `flows/${path.split("/").at(-1)}`,
        task_ids: ["step"],
      });
    return Response.json({ name: "timerSession", state: "idle", etag: "0" });
  };
  const api = createPlanningActions({ plus: send, flowday: send });
  const result = await api.load();
  expect(result.plan.tasks[0]?.estimatedMinutes).toBe(90);
  expect(result.focus.estimates.step).toBe(90);
  // FlowDay's mirrored copy is not read at all.
  expect(result.focus.flowTasks.step?.estimatedMinutes).toBeUndefined();
});

it("takes every estimate from the task list: FlowDay's copy never replaces or fills one", async () => {
  const flowdayCalls: string[] = [];
  const send: HttpSend = async ({ url, httpMethod }) => {
    const path = url.split("?")[0]!;
    if (path === "/api/plus/v1/plan:read")
      return Response.json({
        plan: {
          enabled: true,
          native_planning: true,
          timezone: "UTC",
          today: "2026-10-17",
          week_start: "2026-10-12",
        },
      });
    if (path === "/api/plus/v1/tasks")
      return Response.json({
        planning_tasks: [{ id: "cleared", kind: "step" }],
      });
    flowdayCalls.push(`${httpMethod} ${path}`);
    if (path === "/api/v1/tasks")
      return Response.json({
        tasks: [
          {
            name: "tasks/cleared",
            title: "Synthetic cleared step",
            todoist_id: "cleared",
            estimated_minutes: 45,
          },
          {
            name: "tasks/local-one",
            title: "Synthetic local task",
            estimated_minutes: 20,
          },
        ],
      });
    if (path.startsWith("/api/v1/flows/"))
      return Response.json({
        name: `flows/${path.split("/").at(-1)}`,
        task_ids: ["cleared", "local-one"],
      });
    return Response.json({ name: "timerSession", state: "idle", etag: "0" });
  };
  const api = createPlanningActions({ plus: send, flowday: send });
  expect("updateEstimate" in api).toBe(false);
  const result = await api.load();
  expect(result.plan.tasks[0]?.estimatedMinutes).toBeUndefined();
  expect(result.focus.estimates).toEqual({ cleared: 0 });
  expect(result.focus.flowTasks.cleared?.estimatedMinutes).toBeUndefined();
  // A local FlowDay task is FlowDay's own, estimate included.
  expect(result.focus.flowTasks["local-one"]?.estimatedMinutes).toBe(20);
  expect(flowdayCalls.every((call) => call.startsWith("GET "))).toBe(true);
});

it("queues and moves a task FlowDay has not mirrored yet without forcing a FlowDay sync", async () => {
  const calls: HttpCall[] = [];
  const send: HttpSend = async (call) => {
    calls.push(call);
    const date = call.url.split("?")[0]!.split("/").at(-1)!.split(":")[0]!;
    if (call.url.includes(":rollover"))
      return Response.json({
        flow: { name: "flows/2026-10-17", task_ids: [] },
        destination_flow: { name: "flows/2026-10-18", task_ids: ["new-step"] },
      });
    return Response.json({
      name: `flows/${date}`,
      task_ids: call.httpMethod === "PATCH" ? ["new-step"] : [],
    });
  };
  const api = createPlanningActions({ plus: send, flowday: send });
  await api.addToDay("new-step", "2026-10-17");
  await api.moveTaskToDay(
    "new-step",
    { date: "2026-10-17", taskIds: ["new-step"], completedTaskIds: [] },
    { date: "2026-10-18", taskIds: [], completedTaskIds: [] },
  );
  expect(calls.map((call) => `${call.httpMethod} ${call.url}`)).toEqual([
    "GET /api/v1/flows/2026-10-17",
    "PATCH /api/v1/flows/2026-10-17?update_mask=task_ids",
    "POST /api/v1/flows/2026-10-17:rollover",
  ]);
});
