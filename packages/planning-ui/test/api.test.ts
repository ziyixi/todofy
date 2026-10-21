import { expect, it, vi } from "vitest";
import type { FocusState } from "../src/model";
import { fakeActions } from "./transport";
const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
/** Every day from `start` to `end`, as ListFocusDays lists them; no range is Tasks' today's week. */
function focusDays(url: URL, queues: Record<string, string[]> = {}) {
  const days = [];
  const end = url.searchParams.get("end_day") || "2026-10-18";
  for (
    let day = url.searchParams.get("start_day") || "2026-10-12";
    day <= end;
    day = new Date(Date.parse(`${day}T12:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10)
  )
    days.push({ day, task_ids: queues[day] ?? [] });
  return days;
}
const focusState = (timerEtag: string): FocusState => ({
  date: "2026-10-13",
  timerEtag,
  taskIds: ["child"],
  completedTaskIds: [],
  entries: [],
  estimates: {},
  tasks: {},
});

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
it("reads a month as ListFocusDays calls of at most seven days, together", async () => {
  const ranges: string[] = [];
  let pending = 0;
  let most = 0;
  const api = fakeActions(
    vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      ranges.push(url.search);
      most = Math.max(most, ++pending);
      await Promise.resolve();
      pending--;
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
  const month = await api.readFocus("2026-09-28", "2026-11-08");
  expect(ranges).toHaveLength(6);
  expect(most).toBe(6);
  expect(ranges.at(-1)).toBe("?start_day=2026-11-02&end_day=2026-11-08");
  expect(month.days).toHaveLength(42);
  expect(month.days[0]!.date).toBe("2026-09-28");
  expect(month.days.at(-1)!.date).toBe("2026-11-08");
  expect(month.days[7]!.entries).toEqual([
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
  expect(Object.keys(month.tasks)).toHaveLength(6);
  expect(month.today).toBe("2026-10-19");
  // A range that ends mid-week reads only its days.
  ranges.length = 0;
  await api.readFocus("2026-10-12", "2026-10-20");
  expect(ranges).toEqual([
    "?start_day=2026-10-12&end_day=2026-10-18",
    "?start_day=2026-10-19&end_day=2026-10-20",
  ]);
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
