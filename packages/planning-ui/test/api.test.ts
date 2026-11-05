import { expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import {
  RpcStatusError,
  type HttpCall,
  type HttpSend,
} from "@ziyixi/proto/http-client";
import { parseStatus } from "@ziyixi/proto/rpc-status";
import { createPlanningActions, planningTask } from "../src/api";
import type { FocusState, PlanningTask } from "../src/model";
import {
  fakeActions,
  focusDays,
  focusQueues,
  focusState,
  json,
  refused,
  tasksStub,
} from "./transport";

it("loads complete pages and the week with Tasks' Focus, and uses the authoritative timer etag for the next command", async () => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    calls.push({ path: url.pathname + url.search, body });
    if (url.pathname === "/api/tasks/v1/plan")
      return json({
        name: "plan",
        time_zone: "UTC",
        week_start: "2026-10-12",
        today: "2026-10-13",
      });
    if (url.pathname === "/api/tasks/v1/tasks")
      return url.searchParams.get("page_token")
        ? json({
            tasks: [
              {
                id: "child",
                name: "tasks/child",
                title: "A small step",
                parent_id: "parent",
                stage: "none",
                board_stage: "none",
                area: "work",
                duration_minutes: 45,
              },
            ],
          })
        : json({
            tasks: [
              {
                id: "parent",
                name: "tasks/parent",
                title: "A project",
                stage: "committed",
                board_stage: "committed",
                area: "work",
              },
            ],
            next_page_token: "second",
          });
    if (url.pathname === "/api/tasks/v1/focusDays")
      return json({
        days: focusDays(url, { "2026-10-13": ["child"] }),
        entries: [
          {
            name: "focusEntries/morning",
            task_id: "child",
            day: "2026-10-13",
            seconds: 1500,
            start_time: "2026-10-13T09:40:00Z",
            source: "timer",
            area: "work",
            etag: "1",
          },
        ],
        tasks: [
          {
            task_id: "child",
            title: "A small step",
            parent_id: "parent",
            parent_title: "A project",
            duration_minutes: 45,
          },
        ],
        today: "2026-10-13",
      });
    if (url.pathname === "/api/tasks/v1/focusTimer")
      return json({ name: "focusTimer", state: "idle", etag: "42" });
    if (url.pathname === "/api/tasks/v1/focusTimer:command")
      return json({
        timer: {
          name: "focusTimer",
          task_id: "child",
          day: "2026-10-13",
          area: "work",
          state: "running",
          etag: "43",
          saved_seconds: 5,
          segment_start_time: "2026-10-13T12:00:00Z",
        },
      });
    throw new Error("Unexpected request " + url.pathname);
  });
  const api = fakeActions(fetcher);
  expect("completeTask" in api).toBe(false);
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
  // Every open task, steps included, in pages of 100.
  expect(
    calls
      .filter((call) => call.path.startsWith("/api/tasks/v1/tasks?"))
      .map((call) => call.path),
  ).toEqual([
    "/api/tasks/v1/tasks?view=all&page_size=100",
    "/api/tasks/v1/tasks?view=all&page_size=100&page_token=second",
  ]);
  expect(plan.today).toBe("2026-10-13");
  expect(focus.date).toBe("2026-10-13");
  expect(focus.taskIds).toEqual(["child"]);
  expect(focus.entries).toEqual([
    {
      id: "morning",
      taskId: "child",
      date: "2026-10-13",
      seconds: 1500,
      startedAt: "2026-10-13T09:40:00.000Z",
      source: "timer",
      area: "work",
      etag: "1",
    },
  ]);
  expect(focus.tasks.child).toEqual({
    title: "A small step",
    parentId: "parent",
    parentTitle: "A project",
    estimatedMinutes: 45,
    completed: false,
  });
  expect(focus.estimates.child).toBe(45);
  expect(focus.timerEtag).toBe("42");
  // One read of Tasks' today's week, which needs no other answer first.
  expect(
    calls.filter((call) => call.path.startsWith("/api/tasks/v1/focusDays")),
  ).toEqual([
    {
      path: "/api/tasks/v1/focusDays?start_day=&end_day=",
      body: {},
    },
  ]);
  const timerCallsStart = calls.length;
  const confirmed = await api.timer("start", "child", focus, 1500, "work");
  expect(confirmed).toEqual({
    timerEtag: "43",
    timer: {
      taskId: "child",
      day: "2026-10-13",
      area: "work",
      status: "running",
      elapsedSeconds: 5,
      startedAt: "2026-10-13T12:00:00.000Z",
      etag: "43",
    },
  });
  expect(calls.slice(timerCallsStart)).toHaveLength(1);
  expect(calls.at(-1)!.body).toMatchObject({
    etag: "42",
    action: "start",
    task_id: "child",
    target_seconds: 1500,
    area: "work",
  });

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
  // The shown week, then Tasks' today, which it leaves out.
  expect(
    calls
      .slice(futureCallsStart)
      .filter((call) => call.path.startsWith("/api/tasks/v1/focusDays"))
      .map((call) => call.path.split("?")[1]),
  ).toEqual([
    "start_day=2026-10-19&end_day=2026-10-25",
    "start_day=2026-10-13&end_day=2026-10-13",
  ]);
});
it("reads only the selected week's seven queues, in one call, with the tasks they name, when changing weeks", async () => {
  const paths: string[] = [];
  const api = fakeActions(
    vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname !== "/api/tasks/v1/focusDays")
        throw new Error(
          "Week selection must not scan tasks or account metadata",
        );
      return json({
        days: focusDays(url).map((day) => ({
          ...day,
          task_ids: ["synthetic-step"],
          done_task_ids: ["synthetic-completed"],
        })),
        // A done step is not in Plan's list: the week's read names it.
        tasks: [
          {
            task_id: "synthetic-completed",
            title: "Synthetic done step",
            parent_id: "synthetic-outcome",
            parent_title: "Synthetic outcome",
            duration_minutes: 30,
            completed: true,
          },
        ],
        today: "2026-10-13",
      });
    }),
  );
  const { days, tasks } = await api.loadDays("2026-10-19");
  expect(paths).toHaveLength(1);
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
  expect(tasks).toEqual({
    "synthetic-completed": {
      title: "Synthetic done step",
      parentId: "synthetic-outcome",
      parentTitle: "Synthetic outcome",
      estimatedMinutes: 30,
      completed: true,
    },
  });
});
it("reads one Focus day in one ListFocusDays call, with its records and the tasks they name", async () => {
  const ranges: string[] = [];
  const api = fakeActions(
    vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      ranges.push(url.search);
      const start = url.searchParams.get("start_day")!;
      return json({
        days: focusDays(url),
        entries: [
          {
            name: `focusEntries/${start}`,
            task_id: "step",
            day: start,
            seconds: 600,
            source: "manual",
            etag: "1",
          },
        ],
        tasks: [{ task_id: `task-${start}`, title: "Synthetic step" }],
        today: "2026-10-19",
      });
    }),
  );
  const day = await api.readFocus("2026-10-05");
  expect(ranges).toEqual(["?start_day=2026-10-05&end_day=2026-10-05"]);
  expect(day.days.map((item) => item.date)).toEqual(["2026-10-05"]);
  expect(day.days[0]!.entries).toEqual([
    {
      id: "2026-10-05",
      taskId: "step",
      date: "2026-10-05",
      seconds: 600,
      source: "manual",
      area: "unassigned",
      etag: "1",
    },
  ]);
  expect(Object.keys(day.tasks)).toEqual(["task-2026-10-05"]);
  expect(day.today).toBe("2026-10-19");
});
it("returns a stopped timer and the record it saved without reloading the task lists", async () => {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    expect(new URL(String(input)).pathname).toBe(
      "/api/tasks/v1/focusTimer:command",
    );
    // Only Start sends an area or a target.
    expect(JSON.parse(String(init?.body))).toEqual({
      request_id: expect.any(String),
      etag: "43",
      action: "stop",
      task_id: "child",
    });
    return json({
      timer: { name: "focusTimer", state: "idle", etag: "44" },
      entry: {
        name: "focusEntries/session",
        task_id: "child",
        day: "2026-10-13",
        seconds: 1500,
        start_time: "2026-10-13T12:00:00Z",
        source: "timer",
        area: "personal",
        etag: "1",
      },
    });
  });
  const api = fakeActions(fetcher);
  const confirmed = await api.timer("stop", "child", focusState("43"));
  expect(confirmed).toEqual({
    timerEtag: "44",
    entry: {
      id: "session",
      taskId: "child",
      date: "2026-10-13",
      seconds: 1500,
      startedAt: "2026-10-13T12:00:00.000Z",
      source: "timer",
      area: "personal",
      etag: "1",
    },
  });
  expect(confirmed.timer).toBeUndefined();
  expect(fetcher).toHaveBeenCalledOnce();
});
it("does not present partial task pages as a complete plan", async () => {
  const api = fakeActions(
    vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/tasks/v1/tasks")
        return json({ next_page_token: "more" });
      if (url.pathname === "/api/tasks/v1/focusDays")
        return json({ days: focusDays(url), today: "2026-10-13" });
      return json({ name: "plan", today: "2026-10-13" });
    }),
  );
  await expect(api.load()).rejects.toThrow("incomplete");
});
it("replays an uncertain timer command with the same UUID until acknowledged", async () => {
  const ids: string[] = [];
  const api = fakeActions(
    vi.fn<typeof fetch>(async (_input, init) => {
      ids.push(
        (JSON.parse(String(init?.body)) as { request_id: string }).request_id,
      );
      if (ids.length === 1) throw new TypeError("Synthetic response loss");
      return json({
        timer: { name: "focusTimer", state: "running", etag: "1" },
      });
    }),
  );
  const focus = focusState("0");
  await expect(api.timer("start", "child", focus)).rejects.toThrow();
  await api.timer("start", "child", focus);
  expect(ids[0]).toBe(ids[1]);
  // Confirmed, the same command again is a new one.
  await api.timer("start", "child", focus);
  expect(new Set(ids).size).toBe(2);
});
it("takes the estimate from the task list and keeps a paused timer on its own day", async () => {
  let command: Record<string, unknown> = {};
  const api = fakeActions(
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path === "/api/tasks/v1/plan")
        return json({
          name: "plan",
          time_zone: "UTC",
          week_start: "2026-10-12",
          today: "2026-10-13",
        });
      if (path === "/api/tasks/v1/tasks")
        return json({
          tasks: [
            {
              id: "child",
              name: "tasks/child",
              title: "Synthetic step",
              duration_minutes: 60,
            },
          ],
        });
      if (path === "/api/tasks/v1/focusDays")
        return json({
          days: focusDays(url, { "2026-10-13": ["child"] }),
          today: "2026-10-13",
        });
      if (path === "/api/tasks/v1/focusTimer")
        return json({
          name: "focusTimer",
          task_id: "child",
          state: "paused",
          day: "2026-10-12",
          area: "work",
          saved_seconds: 300,
          etag: "3",
        });
      command = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({
        timer: { name: "focusTimer", state: "running", etag: "4" },
      });
    }),
  );
  const { plan, focus } = await api.load();
  expect(plan.tasks[0]?.estimatedMinutes).toBe(60);
  expect(focus.timer).toMatchObject({
    day: "2026-10-12",
    area: "work",
    status: "paused",
    elapsedSeconds: 300,
  });
  await api.timer("resume", "child", focus);
  // Tasks keeps the session's day; a resume names only the session's task.
  expect(command).toEqual({
    request_id: expect.any(String),
    etag: "3",
    action: "resume",
    task_id: "child",
  });
});
it("adds, changes and deletes a record, replaying an uncertain write with its request ID", async () => {
  const calls: { method: string; url: URL; body: unknown }[] = [];
  let lose = true;
  const api = fakeActions(
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      calls.push({
        method: init?.method ?? "GET",
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (lose) {
        lose = false;
        throw new TypeError("Synthetic response loss");
      }
      if (init?.method === "DELETE") return json({});
      return json({
        name: "focusEntries/added",
        task_id: "step",
        day: "2026-10-12",
        seconds: init?.method === "PATCH" ? 2400 : 900,
        source: "manual",
        area: "personal",
        etag: init?.method === "PATCH" ? "2" : "1",
      });
    }),
  );
  const entry = {
    taskId: "step",
    date: "2026-10-12",
    seconds: 900,
    area: "personal" as const,
  };
  await expect(api.addEntry(entry)).rejects.toThrow();
  const { savedEntry } = await api.addEntry(entry);
  const [lost, added] = calls;
  expect(added!.url.searchParams.get("request_id")).toBe(
    lost!.url.searchParams.get("request_id"),
  );
  expect([added!.method, added!.url.pathname, added!.body]).toEqual([
    "POST",
    "/api/tasks/v1/focusEntries",
    { task_id: "step", day: "2026-10-12", seconds: 900, area: "personal" },
  ]);
  expect(savedEntry).toEqual({
    id: "added",
    ...entry,
    source: "manual",
    etag: "1",
  });

  const changed = await api.updateEntry(savedEntry, 2400);
  const update = calls.at(-1)!;
  expect([update.method, update.url.pathname, update.body]).toEqual([
    "PATCH",
    "/api/tasks/v1/focusEntries/added",
    { seconds: 2400 },
  ]);
  expect(update.url.searchParams.get("update_mask")).toBe("seconds");
  expect(update.url.searchParams.get("etag")).toBe("1");
  expect(changed.savedEntry).toMatchObject({ seconds: 2400, etag: "2" });

  expect(await api.deleteEntry(changed.savedEntry)).toEqual({
    deletedEntry: { id: "added", date: "2026-10-12" },
  });
  const removal = calls.at(-1)!;
  expect([removal.method, removal.url.pathname]).toEqual([
    "DELETE",
    "/api/tasks/v1/focusEntries/added",
  ]);
  expect(removal.url.searchParams.get("etag")).toBe("2");
  expect(removal.url.searchParams.get("request_id")).toMatch(
    /^[0-9a-f-]{36}$/u,
  );
});

it("saves a deadline and its lead days in one UpdateTask and returns the confirmed task", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const api = fakeActions(
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      calls.push({
        path:
          url.pathname +
          url.search.replace(/request_id=[^&]+/u, "request_id=…"),
        body: JSON.parse(String(init?.body)),
      });
      if (url.pathname === "/api/tasks/v1/tasks/child")
        return json({
          id: "child",
          name: "tasks/child",
          title: "Synthetic step",
          stage: "weekly",
          board_stage: "weekly",
          deadline: "2026-10-30",
          lead_days: 7,
          etag: "child-2",
          duration_minutes: 480,
        });
      throw new Error("Unexpected request " + url.pathname);
    }),
  );
  const lead = await api.updateLead(
    {
      id: "child",
      title: "Synthetic step",
      parentId: "",
      projectId: "",
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
    // The shown estimate stays until the next complete read.
    estimatedMinutes: 30,
  });
  expect(calls).toEqual([
    {
      path: "/api/tasks/v1/tasks/child?update_mask=deadline%2Clead_days&request_id=…&etag=child-1",
      body: { deadline: "2026-10-30", lead_days: 7 },
    },
  ]);
});

it("preserves the server refusal when a Bet's new goal cannot be selected", async () => {
  const status = parseStatus(400, {
    error: {
      code: 400,
      status: "FAILED_PRECONDITION",
      message: "Choose an active Key Result",
      details: [
        {
          "@type": "type.googleapis.com/google.rpc.ErrorInfo",
          reason: "PRECONDITION_FAILED",
          domain: "tasks.ziyixi.science",
        },
      ],
    },
  });
  if (!status) throw new Error("Synthetic goal refusal is invalid");
  const refusal = new RpcStatusError(status);
  const actions = fakeActions(async () => {
    throw refusal;
  });
  await expect(
    actions.setWeeklyBet(
      {
        weekStart: "2026-10-12",
        area: "work",
        text: "Synthetic Bet",
        etag: "1",
        keyResultId: "inactive-result",
      },
      ["key_result_id"],
    ),
  ).rejects.toBe(refusal);
});

it("writes only the requested weekly Bet field and preserves joined goal references", async () => {
  const requests: { url: URL; body: Record<string, unknown> }[] = [];
  const actions = fakeActions(async (url, init) => {
    requests.push({
      url,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return Response.json({
      week_start: "2026-10-12",
      area: "work",
      text: "Synthetic Bet",
      key_result_id: "synthetic-result",
      key_result_title: "Synthetic annual result",
      etag: "2",
    });
  });
  const bet = {
    weekStart: "2026-10-12",
    area: "work" as const,
    text: "Synthetic Bet",
    etag: "1",
    keyResultId: "synthetic-result",
  };
  const saved = await actions.setWeeklyBet(bet);
  expect(saved).toMatchObject({
    keyResultId: "synthetic-result",
    keyResultTitle: "Synthetic annual result",
  });
  expect(requests[0]?.url.searchParams.get("update_mask")).toBe("text");
  await actions.setWeeklyBet({ ...saved, keyResultId: "" }, ["key_result_id"]);
  expect(requests[1]?.url.searchParams.get("update_mask")).toBe(
    "key_result_id",
  );
  // The wire profile omits default strings; the explicit mask makes this a clear.
  expect(requests[1]?.body).not.toHaveProperty("key_result_id");
});

/** A task as Plan holds it, with Tasks' order and etag. */
const heldOrderTask = (task: {
  id: string;
  parent_id?: string;
  sort_order: number;
  etag: string;
}) =>
  planningTask(
    create(TaskSchema, {
      id: task.id,
      name: `tasks/${task.id}`,
      parentId: task.parent_id ?? "",
      sortOrder: task.sort_order,
      etag: task.etag,
    }),
  );

it("writes same-day sorting, cross-day movement, pool placement and removal as one MoveFocusStep each", async () => {
  const queues = new Map([
    ["2026-10-13", ["other", "a", "b"]],
    ["2026-10-14", ["other-two", "c"]],
  ]);
  const move = focusQueues(queues);
  const requests: {
    path: string;
    method: string;
    body: Record<string, string>;
  }[] = [];
  const api = fakeActions(async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, string>)
      : {};
    requests.push({ path: url.pathname, method: init?.method ?? "GET", body });
    if (url.pathname === "/api/tasks/v1/focusDays:moveStep") {
      const answer = move(body as Parameters<typeof move>[0]);
      return "error" in answer
        ? Response.json(
            {
              error: {
                code: 400,
                status: "FAILED_PRECONDITION",
                message: answer.error,
              },
            },
            { status: 400 },
          )
        : Response.json(answer);
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const day = (date: string) => ({ date, taskIds: [], completedTaskIds: [] });
  const tuesday = day("2026-10-13");
  const wednesday = day("2026-10-14");
  const thursday = day("2026-10-15");

  expect(await api.moveTaskToDay("b", tuesday, tuesday, "a")).toEqual([
    { date: tuesday.date, taskIds: ["other", "b", "a"], completedTaskIds: [] },
  ]);
  expect(await api.moveTaskToDay("a", tuesday, wednesday, "c")).toEqual([
    { date: tuesday.date, taskIds: ["other", "b"], completedTaskIds: [] },
    {
      date: wednesday.date,
      taskIds: ["other-two", "a", "c"],
      completedTaskIds: [],
    },
  ]);
  expect(await api.moveTaskToDay("d", undefined, thursday)).toEqual([
    { date: thursday.date, taskIds: ["d"], completedTaskIds: [] },
  ]);
  expect(await api.addToDay("e", tuesday.date)).toEqual([
    { date: tuesday.date, taskIds: ["other", "b", "e"], completedTaskIds: [] },
  ]);
  expect(await api.removeFromDay("other", tuesday.date)).toEqual([
    { date: tuesday.date, taskIds: ["b", "e"], completedTaskIds: [] },
  ]);
  // A drop on itself writes nothing.
  const noOpStart = requests.length;
  expect(await api.moveTaskToDay("b", tuesday, tuesday, "b")).toEqual([]);
  expect(requests).toHaveLength(noOpStart);
  expect(
    requests.map(({ method, path, body }) => {
      const { request_id: requestId, ...rest } = body;
      expect(requestId).toMatch(/^[0-9a-f-]{36}$/u);
      return [method, path, rest];
    }),
  ).toEqual([
    [
      "POST",
      "/api/tasks/v1/focusDays:moveStep",
      {
        task_id: "b",
        source_day: "2026-10-13",
        destination_day: "2026-10-13",
        before_task_id: "a",
      },
    ],
    [
      "POST",
      "/api/tasks/v1/focusDays:moveStep",
      {
        task_id: "a",
        source_day: "2026-10-13",
        destination_day: "2026-10-14",
        before_task_id: "c",
      },
    ],
    [
      "POST",
      "/api/tasks/v1/focusDays:moveStep",
      { task_id: "d", destination_day: "2026-10-15" },
    ],
    [
      "POST",
      "/api/tasks/v1/focusDays:moveStep",
      { task_id: "e", destination_day: "2026-10-13" },
    ],
    [
      "POST",
      "/api/tasks/v1/focusDays:moveStep",
      { task_id: "other", source_day: "2026-10-13" },
    ],
  ]);
  // Each confirmed move had its own request ID.
  expect(new Set(requests.map(({ body }) => body.request_id)).size).toBe(5);
  // Tasks' refusal reaches the caller, and nothing is changed in the meantime.
  await expect(api.removeFromDay("other", tuesday.date)).rejects.toThrow(
    "This step has moved.",
  );
});

it("retries a move whose answer was lost with the same request ID", async () => {
  const ids: string[] = [];
  const api = fakeActions(async (_input, init) => {
    ids.push(JSON.parse(String(init?.body)).request_id);
    if (ids.length === 1) throw new TypeError("Synthetic response loss");
    return Response.json({ days: [{ day: "2026-10-13", task_ids: ["a"] }] });
  });
  await expect(api.addToDay("a", "2026-10-13")).rejects.toThrow();
  await api.addToDay("a", "2026-10-13");
  // A different move is a different request.
  await api.addToDay("a", "2026-10-14");
  expect(ids[1]).toBe(ids[0]);
  expect(ids[2]).not.toBe(ids[0]);
});

it("creates each new step in Tasks, in order, under IDs fixed for its add, and answers their IDs", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let lose = true;
  const api = fakeActions(async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    requests.push({ path: url.pathname + url.search, body });
    if (url.pathname === "/api/tasks/v1/tasks") {
      // The second step's answer is lost once.
      if (body.title === "Synthetic step 2" && lose) {
        lose = false;
        throw new TypeError("Synthetic response loss");
      }
      return Response.json({ id: url.searchParams.get("task_id"), name: "x" });
    }
    if (url.pathname === "/api/tasks/v1/focusDays:moveStep")
      return Response.json({
        days: [{ day: body.destination_day, task_ids: [body.task_id] }],
      });
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const outcome = { id: "outcome" } as Parameters<typeof api.createSteps>[0];
  const steps = [
    { title: "Synthetic step 1", estimatedMinutes: 30 },
    { title: "Synthetic step 2" },
  ];
  const add = "11111111-1111-4111-8111-111111111111";
  await expect(api.createSteps(outcome, steps, add)).rejects.toThrow();
  const ids = await api.createSteps(outcome, steps, add);
  expect(requests.map((request) => request.body)).toEqual([
    {
      title: "Synthetic step 1",
      parent_id: "outcome",
      duration_minutes: 30,
      kind: "step",
    },
    { title: "Synthetic step 2", parent_id: "outcome", kind: "step" },
    {
      title: "Synthetic step 1",
      parent_id: "outcome",
      duration_minutes: 30,
      kind: "step",
    },
    { title: "Synthetic step 2", parent_id: "outcome", kind: "step" },
  ]);
  // The retry resends the same task and request IDs, so Tasks replays what it already made.
  const query = (index: number) =>
    new URLSearchParams(requests[index]!.path.split("?")[1]);
  for (const index of [0, 1])
    for (const key of ["task_id", "request_id"])
      expect(query(index + 2).get(key)).toBe(query(index).get(key));
  expect(ids).toEqual([query(0).get("task_id"), query(1).get("task_id")]);
  expect(await api.addToDay(ids[0]!, "2026-10-13")).toEqual([
    { date: "2026-10-13", taskIds: [ids[0]], completedTaskIds: [] },
  ]);
  // Another add is new steps.
  requests.length = 0;
  await api.createSteps(
    outcome,
    steps.slice(0, 1),
    "33333333-3333-4333-8333-333333333333",
  );
  expect(query(0).get("task_id")).not.toBe(ids[0]);
});

it("maps Tasks' sibling order and the saved lane orders, and sends one reorder of the moved task's siblings under the etags Plan holds", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const listed = [
    // b is moved before a among the siblings of one parent; c, under another parent, keeps its place.
    {
      id: "a",
      name: "tasks/a",
      title: "Synthetic a",
      parent_id: "p",
      sort_order: 1,
      etag: "1",
    },
    {
      id: "b",
      name: "tasks/b",
      title: "Synthetic b",
      parent_id: "p",
      sort_order: 2.5,
      etag: "1",
    },
    {
      id: "c",
      name: "tasks/c",
      title: "Synthetic c",
      parent_id: "q",
      sort_order: 0,
      etag: "1",
    },
  ];
  const api = fakeActions(async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    requests.push({ path: url.pathname + url.search, body });
    if (url.pathname === "/api/tasks/v1/plan")
      return Response.json({
        name: "plan",
        week_start: "2026-10-12",
        today: "2026-10-13",
        time_zone: "UTC",
        // A lane a later Tasks might add is not this build's.
        lane_orders: [
          { lane: "committed", task_ids: ["b", "a"] },
          { lane: "someday", task_ids: ["c"] },
        ],
      });
    if (url.pathname === "/api/tasks/v1/tasks:reorder")
      return Response.json({
        tasks: [
          {
            ...listed[1],
            sort_order: 1,
            etag: "2",
            update_time: "2026-10-13T08:00:00Z",
          },
          { ...listed[0], sort_order: 2.5, etag: "2" },
        ],
        lane_order: { lane: "committed", task_ids: ["b", "a", "c"] },
      });
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  expect((await api.readPlan()).laneOrders).toEqual({ committed: ["b", "a"] });
  const [a, b, c] = listed.map(heldOrderTask);
  const result = await api.reorderTasks(
    [b!, a!, c!],
    "b",
    "committed",
    "22222222-2222-4222-8222-222222222222",
  );
  // No read first: Plan already holds every task's order and etag.
  expect(requests.slice(1).map((request) => request.path)).toEqual([
    "/api/tasks/v1/tasks:reorder",
  ]);
  expect(requests.at(-1)?.body).toEqual({
    positions: [
      { name: "tasks/b", etag: "1", sort_order: 1 },
      { name: "tasks/a", etag: "1", sort_order: 2.5 },
    ],
    request_id: "22222222-2222-4222-8222-222222222222",
    lane_order: { lane: "committed", task_ids: ["b", "a", "c"] },
  });
  expect(
    result.reordered.map(({ id, sortOrder, childOrder, etag, updatedAt }) => ({
      id,
      sortOrder,
      childOrder,
      etag,
      updatedAt,
    })),
  ).toEqual([
    {
      id: "b",
      sortOrder: 1,
      childOrder: 1,
      etag: "2",
      updatedAt: "2026-10-13T08:00:00.000Z",
    },
    {
      id: "a",
      sortOrder: 2.5,
      childOrder: undefined,
      etag: "2",
      updatedAt: undefined,
    },
  ]);
  expect(result.lane).toEqual({ lane: "committed", taskIds: ["b", "a", "c"] });
  // Waiting and Parked change no task: their order alone.
  requests.length = 0;
  await api.reorderTasks(
    [a!, b!],
    "a",
    "waiting",
    "44444444-4444-4444-8444-444444444444",
  );
  expect(requests.map((request) => [request.path, request.body])).toEqual([
    [
      "/api/tasks/v1/tasks:reorder",
      {
        positions: [],
        request_id: "44444444-4444-4444-8444-444444444444",
        lane_order: { lane: "waiting", task_ids: ["a", "b"] },
      },
    ],
  ]);
});

it("resends a reorder whose answer was lost as first built, and builds a refused one again", async () => {
  const bodies: unknown[] = [];
  let answer: () => Response | never = () => {
    throw new TypeError("Synthetic response loss");
  };
  const api = fakeActions(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return answer();
  });
  // b moves before a; Plan reads both again (etag 2) after the lost answer.
  const order = (etag: string) =>
    ["b", "a"].map((id) =>
      heldOrderTask({ id, sort_order: id === "a" ? 0 : 1, etag }),
    );
  const request = "55555555-5555-4555-8555-555555555555";
  await expect(
    api.reorderTasks(order("1"), "b", "", request),
  ).rejects.toThrow();
  answer = () =>
    Response.json(
      {
        error: {
          code: 409,
          status: "ABORTED",
          message: "changed",
          details: [],
        },
      },
      { status: 409 },
    );
  await expect(
    api.reorderTasks(order("2"), "b", "", request),
  ).rejects.toThrow();
  answer = () => Response.json({});
  await api.reorderTasks(order("2"), "b", "", request);
  const etags = bodies.map(
    (body) => (body as { positions: { etag: string }[] }).positions[0]?.etag,
  );
  // The lost answer's retry is the same request; once Tasks refused it, the next is built anew.
  expect(etags).toEqual(["1", "1", "2"]);
});

it("sends planning switches as Task.planning_flags over the task's own, and only the masked fields", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const api = fakeActions(async (input, init) => {
    const url = new URL(String(input));
    requests.push({
      path: url.searchParams.get("update_mask") ?? "",
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return Response.json({ id: "a", name: "tasks/a", title: "Synthetic a" });
  });
  const task = {
    id: "a",
    etag: "a-1",
    planningFlags: ["active", "waiting"],
  } as Parameters<typeof api.updateTask>[0];
  await api.updateTask(task, { parked: true });
  await api.updateTask(task, { stage: "monthly", parked: false });
  await api.updateTask(task, { area: "personal" });
  expect(requests).toEqual([
    {
      path: "planning_flags",
      body: { planning_flags: ["active", "waiting", "parked"] },
    },
    {
      path: "stage,planning_flags",
      body: { stage: "monthly", planning_flags: ["active", "waiting"] },
    },
    {
      path: "area",
      body: { area: "personal" },
    },
  ]);
});

it("preserves the native scheduled clock and time zone separately from its date and estimate", () => {
  const task = create(TaskSchema, {
    id: "timed-quick",
    title: "Synthetic timed Quick",
    dueDate: "2026-10-13",
    dueDatetime: "2026-10-13T04:25:00Z",
    dueTimezone: "Asia/Tokyo",
    planningFlags: ["quick", "task"],
    durationMinutes: 20,
  });
  expect(planningTask(task)).toMatchObject({
    due: task.dueDate,
    dueDatetime: task.dueDatetime,
    dueTimezone: task.dueTimezone,
    estimatedMinutes: 20,
    planningFlags: ["quick", "task"],
  });
  expect(task.durationMinutes).toBe(20);
});

const waiter = {
  id: "a",
  name: "tasks/a",
  title: "Synthetic waiter",
  etag: "3",
  dependencies: [{ prerequisite_id: "c", title: "Synthetic done", done: true }],
};

it("maps the recurring flag and Tasks' counter", () => {
  const counted = planningTask(
    create(TaskSchema, {
      id: "a",
      recurrence: "every week",
      completedCount: 4,
    }),
  );
  expect([counted.recurring, counted.completedCount]).toEqual([true, 4]);
  expect(planningTask(create(TaskSchema, { id: "b" })).recurring).toBe(false);
});

/** The waiting task as Plan holds it: Tasks' etag, which every write goes under. */
const heldWaiter = planningTask(
  create(TaskSchema, { id: "a", name: "tasks/a", etag: "3" }),
);

it("writes a dependency as the waiting task's new set in one write under the etag Plan holds, and answers the saved task", async () => {
  const saved = {
    ...waiter,
    etag: "4",
    dependencies: [
      ...waiter.dependencies,
      { prerequisite_id: "b", title: "Synthetic open" },
    ],
  };
  const { api, requests } = tasksStub({
    "PATCH /api/tasks/v1/tasks/a": () => Response.json(saved),
  });
  const result = await api.setDependencies(heldWaiter, ["c", "b"], {
    id: "b",
    restart: false,
  });
  expect(result).toMatchObject({
    forTask: "a",
    dependencies: [
      { taskId: "a", prerequisiteId: "c", done: true },
      { taskId: "a", prerequisiteId: "b", done: false },
    ],
    task: { id: "a", etag: "4" },
  });
  expect(requests).toEqual([
    {
      method: "PATCH",
      path: "/api/tasks/v1/tasks/a",
      etag: "3",
      body: {
        dependencies: [{ prerequisite_id: "c" }, { prerequisite_id: "b" }],
      },
    },
  ]);
  // Removing sends the set without it; the wire leaves an empty set out, and the mask still names it.
  requests.length = 0;
  await api.setDependencies(heldWaiter, []);
  expect(requests.map((request) => request.path)).toEqual([
    "/api/tasks/v1/tasks/a",
  ]);
  expect(requests[0]?.body).toEqual({});
});

it("restarts a done dependency by removing it and adding it again, the second write under the first one's etag", async () => {
  let answer = 0;
  const { api, requests } = tasksStub({
    "PATCH /api/tasks/v1/tasks/a": () =>
      Response.json(
        ++answer === 1
          ? { ...waiter, etag: "4", dependencies: [] }
          : {
              ...waiter,
              etag: "5",
              dependencies: [{ prerequisite_id: "c", title: "Synthetic done" }],
            },
      ),
  });
  const result = await api.setDependencies(heldWaiter, ["c"], {
    id: "c",
    restart: true,
  });
  expect(requests.map(({ etag, body }) => ({ etag, body }))).toEqual([
    { etag: "3", body: {} },
    { etag: "4", body: { dependencies: [{ prerequisite_id: "c" }] } },
  ]);
  expect(result).toMatchObject({
    dependencies: [{ taskId: "a", prerequisiteId: "c", done: false }],
    task: { etag: "5" },
  });
});

it("says why Tasks did not add a dependency, claiming no cause the refusal does not carry", async () => {
  for (const [reason, status, message] of [
    // A cycle or the limit from another tab, or a prerequisite that is no longer open, alike.
    [
      "PRECONDITION_FAILED",
      400,
      "Not added: this dependency cannot be added now. Refresh and try again.",
    ],
    [
      "NOT_FOUND",
      404,
      "Not added: one of these tasks is no longer active. Refresh and try again.",
    ],
  ] as const) {
    const { api } = tasksStub({
      "PATCH /api/tasks/v1/tasks/a": () => refused(reason, status),
    });
    const error = await api
      .setDependencies(heldWaiter, ["c", "b"], { id: "b", restart: false })
      .catch((failure: unknown) => failure);
    // Plan shows a failed write's own message.
    expect((error as Error).message).toBe(message);
  }
});

it("deletes a Step through Tasks under Plan's etag and the same request ID on retry", async () => {
  const calls: HttpCall[] = [];
  const send: HttpSend = async (call) => {
    calls.push(call);
    if (calls.length === 1) throw new Error("Synthetic lost response");
    return Response.json({});
  };
  const actions = createPlanningActions({ tasks: send });
  const task = { id: "synthetic-step", etag: "step-3" } as PlanningTask;
  await expect(actions.deleteTask(task, "same-delete-request")).rejects.toThrow(
    "Synthetic lost response",
  );
  await actions.deleteTask(task, "same-delete-request");
  expect(calls).toHaveLength(2);
  expect(calls[0]).toEqual(calls[1]);
  expect(calls[0]).toMatchObject({
    httpMethod: "DELETE",
    url: "/api/tasks/v1/tasks/synthetic-step?etag=step-3&request_id=same-delete-request",
  });
});

it("reads the weekly review's two facts for the plan's week from Tasks, a zero count included", async () => {
  const calls: HttpCall[] = [];
  const answers = [
    {
      name: "weeklyReviews/2026-10-12",
      review_task_id: "synthetic-review",
      mail_pending_count: 0,
    },
    { name: "weeklyReviews/2026-10-19" },
  ];
  const tasks: HttpSend = async (call) => {
    calls.push(call);
    return Response.json(answers.shift());
  };
  const actions = createPlanningActions({ tasks });
  expect(await actions.readWeeklyReview!("2026-10-12")).toEqual({
    reviewTaskId: "synthetic-review",
    mailboxPendingCount: 0,
  });
  // Without Todofy's answer the count is unknown, not zero.
  expect(await actions.readWeeklyReview!("2026-10-19")).toEqual({
    reviewTaskId: "",
    mailboxPendingCount: undefined,
  });
  expect(calls.map((call) => call.url)).toEqual([
    "/api/tasks/v1/weeklyReviews/2026-10-12",
    "/api/tasks/v1/weeklyReviews/2026-10-19",
  ]);
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
  const api = createPlanningActions({ tasks: send });
  const focus = focusState("0", { date: "2026-10-17", taskIds: ["step"] });
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
  const api = createPlanningActions({ tasks: send });
  const focus = focusState("1", { date: "2026-10-17", taskIds: ["step"] });
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

it("sends when a Pause or Resume takes effect, keeps the pause time to the millisecond, and retries under one request ID", async () => {
  const bodies: Record<string, unknown>[] = [];
  let down = true;
  const send: HttpSend = async (call) => {
    bodies.push(JSON.parse(call.body!));
    if (down) {
      down = false;
      throw new TypeError("Synthetic network failure");
    }
    return Response.json({
      timer: {
        name: "focusTimer",
        state: "paused",
        etag: "3",
        task_id: "step",
        day: "2026-10-17",
        saved_seconds: 300,
        pause_time: "2026-10-17T12:05:00.123Z",
      },
    });
  };
  const api = createPlanningActions({ tasks: send });
  const focus = focusState("2", { date: "2026-10-17", taskIds: ["step"] });
  const at = "2026-10-17T12:05:00.123Z";
  await expect(
    api.timer("pause", "step", focus, undefined, undefined, at),
  ).rejects.toThrow("Synthetic network failure");
  const paused = await api.timer(
    "pause",
    "step",
    focus,
    undefined,
    undefined,
    at,
  );
  expect(bodies[0]).toEqual({
    request_id: expect.any(String),
    etag: "2",
    action: "pause",
    task_id: "step",
    effective_time: at,
  });
  // The same moment is the same request, so Tasks replays it if the first one landed.
  expect(bodies[1]).toEqual(bodies[0]);
  expect(paused.timer).toMatchObject({
    status: "paused",
    elapsedSeconds: 300,
    pausedAt: at,
  });
  // Another moment is another request; without one, Tasks' now.
  await api.timer(
    "pause",
    "step",
    focus,
    undefined,
    undefined,
    "2026-10-17T12:06:00.000Z",
  );
  expect(bodies[2]!.request_id).not.toBe(bodies[0]!.request_id);
  await api.timer("resume", "step", { ...focus, timerEtag: "3" });
  expect(bodies[3]).toEqual({
    request_id: expect.any(String),
    etag: "3",
    action: "resume",
    task_id: "step",
  });
});

it("takes every estimate from the task list; Tasks' Focus read only names tasks the list leaves out", async () => {
  const send: HttpSend = async ({ url }) => {
    const path = url.split("?")[0]!;
    if (path === "/api/tasks/v1/plan")
      return Response.json({
        name: "plan",
        time_zone: "UTC",
        today: "2026-10-17",
        week_start: "2026-10-12",
      });
    if (path === "/api/tasks/v1/tasks")
      return Response.json({
        tasks: [
          {
            id: "step",
            name: "tasks/step",
            kind: "step",
            duration_minutes: 90,
          },
          { id: "cleared", name: "tasks/cleared", kind: "step" },
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
  const api = createPlanningActions({ tasks: send });
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
