import { expect, it } from "vitest";
import { createPlanningActions } from "../src/api";
import type { HttpCall, HttpSend } from "@ziyixi/proto/http-client";
import type { FocusState } from "../src/model";

it("reads the native pending Mail count even when no mail task exists", async () => {
  const send: HttpSend = async () =>
    Response.json({
      plan: { enabled: true, native_planning: true, mailbox_pending_count: 0 },
    });
  const actions = createPlanningActions({ plus: send, tasks: send });
  expect(await actions.readPlan()).toMatchObject({
    mailboxPendingCount: 0,
  });
});

it("starts a pomodoro in Tasks and uses its authoritative session across reload and finish", async () => {
  const calls: HttpCall[] = [];
  const running = {
    name: "focusTimer",
    state: "running",
    etag: "new-version",
    task_id: "step",
    day: "2026-10-17",
    area: "personal",
    target_seconds: 1500,
    saved_seconds: 60,
    segment_start_time: "2026-10-17T12:00:00Z",
  };
  const send: HttpSend = async (call) => {
    calls.push(call);
    const body = call.body ? JSON.parse(call.body) : {};
    if (call.httpMethod === "GET") return Response.json(running);
    return Response.json(
      body.action === "finish"
        ? {
            timer: {
              name: "focusTimer",
              state: "idle",
              etag: "finished",
              finished_task_id: "step",
              finished_seconds: 1500,
            },
            entry: {
              name: "focusEntries/pomodoro",
              task_id: "step",
              day: "2026-10-17",
              seconds: 1500,
              source: "timer",
              area: "personal",
              etag: "1",
            },
          }
        : { timer: running },
    );
  };
  const api = createPlanningActions({ plus: send, tasks: send });
  const focus: FocusState = {
    date: "2026-10-17",
    taskIds: ["step"],
    completedTaskIds: [],
    entries: [],
    timerEtag: "0",
    estimates: {},
    tasks: {},
  };
  const started = await api.timer("start", "step", focus, 1500, "personal");
  expect(calls[0]!.url).toBe("/api/tasks/v1/focusTimer:command");
  expect(JSON.parse(calls[0]!.body!)).toEqual({
    request_id: expect.any(String),
    etag: "0",
    action: "start",
    task_id: "step",
    target_seconds: 1500,
    area: "personal",
  });
  expect(started.timer).toMatchObject({
    day: "2026-10-17",
    area: "personal",
    mode: "pomodoro",
    targetSeconds: 1500,
    elapsedSeconds: 60,
  });
  expect(await api.readTimer!()).toEqual(started);
  expect(calls[1]!.url).toBe("/api/tasks/v1/focusTimer");
  const finished = await api.timer("finish", "step", { ...focus, ...started });
  expect(JSON.parse(calls.at(-1)!.body!)).toEqual({
    request_id: expect.any(String),
    etag: "new-version",
    action: "finish",
    task_id: "step",
  });
  expect(finished).toEqual({
    timerEtag: "finished",
    finishedPomodoro: { taskId: "step", targetSeconds: 1500 },
    entry: {
      id: "pomodoro",
      taskId: "step",
      date: "2026-10-17",
      seconds: 1500,
      source: "timer",
      area: "personal",
      etag: "1",
    },
  });
});

it("counts up when Start has no target, and an unassigned task starts with no area", async () => {
  const bodies: Record<string, unknown>[] = [];
  const send: HttpSend = async (call) => {
    bodies.push(JSON.parse(call.body!));
    return Response.json({
      timer: {
        name: "focusTimer",
        state: "running",
        etag: "2",
        task_id: "step",
        day: "2026-10-17",
        segment_start_time: "2026-10-17T12:00:00Z",
      },
    });
  };
  const api = createPlanningActions({ plus: send, tasks: send });
  const focus = {
    date: "2026-10-17",
    taskIds: ["step"],
    completedTaskIds: [],
    entries: [],
    timerEtag: "1",
    estimates: {},
    tasks: {},
  };
  const started = await api.timer("start", "step", focus, 0, "unassigned");
  // Empty strings are left off the wire, as Tasks reads "" for unassigned.
  expect(bodies[0]).toEqual({
    request_id: expect.any(String),
    etag: "1",
    action: "start",
    task_id: "step",
  });
  expect(started.timer).toEqual({
    taskId: "step",
    day: "2026-10-17",
    area: "unassigned",
    status: "running",
    elapsedSeconds: 0,
    startedAt: "2026-10-17T12:00:00.000Z",
    etag: "2",
  });
});

it("takes every estimate from the task list; Tasks' Focus read only names tasks the list leaves out", async () => {
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
        planning_tasks: [
          { id: "step", kind: "step", estimated_minutes: 90 },
          { id: "cleared", kind: "step" },
        ],
      });
    if (path === "/api/tasks/v1/focusDays")
      return Response.json({
        days: [{ day: "2026-10-17", task_ids: ["step", "cleared", "done"] }],
        tasks: [
          { task_id: "step", title: "Synthetic step", duration_minutes: 90 },
          { task_id: "cleared", title: "Synthetic cleared step" },
          {
            task_id: "done",
            title: "Synthetic completed step",
            parent_id: "outcome",
            parent_title: "Synthetic outcome",
            duration_minutes: 20,
            completed: true,
          },
        ],
        today: "2026-10-17",
      });
    return Response.json({ name: "focusTimer", state: "idle", etag: "1" });
  };
  const api = createPlanningActions({ plus: send, tasks: send });
  expect("updateEstimate" in api).toBe(false);
  const result = await api.load();
  expect(result.plan.tasks[0]?.estimatedMinutes).toBe(90);
  expect(result.plan.tasks[1]?.estimatedMinutes).toBeUndefined();
  expect(result.focus.estimates).toEqual({ step: 90, cleared: 0 });
  expect(result.focus.tasks.done).toEqual({
    title: "Synthetic completed step",
    parentId: "outcome",
    parentTitle: "Synthetic outcome",
    estimatedMinutes: 20,
    completed: true,
  });
});
