import { expect, it } from "vitest";
import { fakeActions } from "./transport";

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

it("answers the new steps' IDs, which Tasks can queue at once", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const api = fakeActions(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    requests.push({ path, body });
    if (path === "/api/plus/v1/tasks:appendTaskSteps")
      return Response.json({ task_ids: ["step-1"] });
    if (path === "/api/tasks/v1/focusDays:moveStep")
      return Response.json({
        days: [{ day: body.destination_day, task_ids: [body.task_id] }],
      });
    throw new Error(`Unexpected request: ${path}`);
  });
  const outcome = { id: "outcome" } as Parameters<typeof api.createSteps>[0];
  expect(
    await api.createSteps(
      outcome,
      [{ title: "Synthetic step 1", estimatedMinutes: 30 }],
      "11111111-1111-4111-8111-111111111111",
    ),
  ).toEqual(["step-1"]);
  expect(requests.at(-1)).toEqual({
    path: "/api/plus/v1/tasks:appendTaskSteps",
    body: {
      parent_id: "outcome",
      request_id: "11111111-1111-4111-8111-111111111111",
      steps: [{ title: "Synthetic step 1", estimated_minutes: 30 }],
    },
  });
  expect(await api.addToDay("step-1", "2026-10-13")).toEqual([
    { date: "2026-10-13", taskIds: ["step-1"], completedTaskIds: [] },
  ]);
  expect(requests.map((request) => request.path)).toEqual([
    "/api/plus/v1/tasks:appendTaskSteps",
    "/api/tasks/v1/focusDays:moveStep",
  ]);
});

it("maps Todoist's sibling order and the saved lane orders, and sends a reorder with the moved task", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const api = fakeActions(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    requests.push({ path, body });
    if (path === "/api/plus/v1/plan:read")
      return Response.json({
        plan: {
          week_start: "2026-10-12",
          today: "2026-10-13",
          timezone: "UTC",
          enabled: true,
          // A lane a later Todofy might add is not this build's.
          lane_orders: [
            { lane: "committed", task_ids: ["b", "a"] },
            { lane: "someday", task_ids: ["c"] },
          ],
        },
      });
    if (path === "/api/plus/v1/tasks:reorder")
      return Response.json({
        tasks: [
          {
            id: "b",
            title: "Synthetic b",
            child_order: -3,
            order_key: "a0",
            update_time: "2026-10-13T08:00:00Z",
          },
          { id: "a", title: "Synthetic a", child_order: 4 },
        ],
        lane_order: { lane: "committed", task_ids: ["b", "a"] },
      });
    throw new Error(`Unexpected request: ${path}`);
  });
  expect((await api.readPlan()).laneOrders).toEqual({ committed: ["b", "a"] });
  const result = await api.reorderTasks(
    ["b", "a"],
    "b",
    "committed",
    "22222222-2222-4222-8222-222222222222",
  );
  expect(requests.at(-1)).toEqual({
    path: "/api/plus/v1/tasks:reorder",
    body: {
      request_id: "22222222-2222-4222-8222-222222222222",
      task_ids: ["b", "a"],
      task_id: "b",
      lane: "committed",
    },
  });
  expect(
    result.reordered.map(({ id, childOrder, orderKey, updatedAt }) => ({
      id,
      childOrder,
      orderKey,
      updatedAt,
    })),
  ).toEqual([
    {
      id: "b",
      childOrder: -3,
      orderKey: "a0",
      updatedAt: "2026-10-13T08:00:00.000Z",
    },
    { id: "a", childOrder: 4, orderKey: undefined, updatedAt: undefined },
  ]);
  expect(result.lane).toEqual({ lane: "committed", taskIds: ["b", "a"] });
});

it("sends a parked change as SetTaskPlan's parked field", async () => {
  const bodies: Record<string, unknown>[] = [];
  const api = fakeActions(async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ task: { id: "a", title: "Synthetic a" } });
  });
  const task = { id: "a", etag: "a-1" } as Parameters<typeof api.updateTask>[0];
  await api.updateTask(task, { parked: true });
  await api.updateTask(task, { stage: "monthly", parked: false });
  expect(bodies).toEqual([
    { task_id: "a", etag: "a-1", request_id: expect.any(String), parked: true },
    {
      task_id: "a",
      etag: "a-1",
      request_id: expect.any(String),
      stage: "monthly",
      parked: false,
    },
  ]);
});
