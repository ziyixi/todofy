import { expect, it } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import { RpcStatusError } from "@ziyixi/proto/http-client";
import { parseStatus } from "@ziyixi/proto/rpc-status";
import { planningTask } from "../src/api";
import { fakeActions } from "./transport";

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
const held = (task: {
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

/**
 * Tasks' MoveFocusStep over synthetic queues: no source adds, no destination removes, the same day
 * reorders and two days move, before `before_task_id` or last. Its answer lists each changed day.
 */
function focusQueues(queues: Map<string, string[]>) {
  const read = (day: string) => queues.get(day) ?? [];
  return (body: {
    task_id: string;
    source_day?: string;
    destination_day?: string;
    before_task_id?: string;
  }) => {
    const { task_id: id, source_day: source, destination_day: target } = body;
    if (source && !read(source).includes(id))
      return { status: 400, error: "This step has moved." };
    if (source)
      queues.set(
        source,
        read(source).filter((item) => item !== id),
      );
    if (target) {
      const queue = read(target).filter((item) => item !== id);
      const before = body.before_task_id
        ? queue.indexOf(body.before_task_id)
        : -1;
      queue.splice(before < 0 ? queue.length : before, 0, id);
      queues.set(target, queue);
    }
    return {
      days: [...new Set([source, target].filter(Boolean))].map((day) => ({
        day,
        task_ids: read(day!),
      })),
    };
  };
}

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
  const [a, b, c] = listed.map(held);
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
    ["b", "a"].map((id) => held({ id, sort_order: id === "a" ? 0 : 1, etag }));
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
