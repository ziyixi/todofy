import { expect, it } from "vitest";
import { createApi } from "../src/api";

it("persists same-day sorting, cross-day movement and pool placement only in FlowDay queues", async () => {
  const flows = new Map([
    [
      "2026-10-13",
      { taskIds: ["local-one", "a", "b", "done"], completed: ["done"] },
    ],
    ["2026-10-14", { taskIds: ["local-two", "c"], completed: [] as string[] }],
  ]);
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const requests: { path: string; method: string }[] = [];
  const read = (date: string) =>
    flows.get(date) ?? { taskIds: [], completed: [] };
  const wire = (date: string) => ({
    name: `flows/${date}`,
    task_ids: read(date).taskIds,
    completed_task_ids: read(date).completed,
  });
  const api = createApi(
    { apiOrigin: "https://api.example.test", token: "synthetic" },
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, method: init?.method ?? "GET" });
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      const reply = (value: unknown) => Response.json(value);
      if (path === "/api/plus/v1/plan:read")
        return reply({
          plan: {
            week_start: "2026-10-12",
            today: "2026-10-13",
            timezone: "UTC",
            enabled: true,
          },
        });
      if (path === "/api/plus/v1/tasks")
        return reply({
          planning_tasks: ["a", "b", "c", "d"].map((id) => ({
            id,
            title: `Synthetic ${id}`,
            deadline: "2026-10-30",
            due: "2026-10-20",
          })),
        });
      if (path.endsWith("/timerSession"))
        return reply({ name: "timerSession", etag: "0" });
      if (path.endsWith("/tasks"))
        return reply({
          tasks: ["a", "b", "c", "d", "done", "local-one", "local-two"].map(
            (id) => ({
              name: `tasks/${id}`,
              todoist_id: id,
              title: `Synthetic ${id}`,
            }),
          ),
        });
      const day = path.match(/\/flows\/(\d{4}-\d{2}-\d{2})/u)?.[1];
      if (!day) throw new Error(`Unexpected request: ${path}`);
      if (init?.method === "PATCH") {
        writes.push({ path, body });
        flows.set(day, { ...read(day), taskIds: body.task_ids as string[] });
        return reply(wire(day));
      }
      if (path.endsWith(":rollover")) {
        writes.push({ path, body });
        const destination = String(body.destination).slice("flows/".length);
        const requested = body.task_ids as string[];
        const moving = read(day).taskIds.filter((id) => requested.includes(id));
        flows.set(day, {
          ...read(day),
          taskIds: read(day).taskIds.filter((id) => !moving.includes(id)),
        });
        flows.set(destination, {
          ...read(destination),
          taskIds: [
            ...moving,
            ...read(destination).taskIds.filter((id) => !moving.includes(id)),
          ],
        });
        return reply({ flow: wire(day), destination_flow: wire(destination) });
      }
      return reply(wire(day));
    },
  );
  const initial = await api.load();
  const tuesday = initial.days.find((day) => day.date === "2026-10-13")!;
  const wednesday = initial.days.find((day) => day.date === "2026-10-14")!;
  const thursday = initial.days.find((day) => day.date === "2026-10-15")!;
  const mutationStart = requests.length;
  const sorted = await api.moveTaskToDay("b", tuesday, tuesday, "a");
  expect(sorted).toEqual([
    {
      date: tuesday.date,
      taskIds: ["local-one", "b", "a", "done"],
      completedTaskIds: ["done"],
    },
  ]);
  expect(read(tuesday.date).taskIds).toEqual(["local-one", "b", "a", "done"]);
  expect(writes.some((write) => write.path.endsWith(":rollover"))).toBe(false);
  const crossStart = requests.length;
  const moved = await api.moveTaskToDay("a", tuesday, wednesday, "c");
  expect(moved).toEqual([
    {
      date: tuesday.date,
      taskIds: ["local-one", "b", "done"],
      completedTaskIds: ["done"],
    },
    {
      date: wednesday.date,
      taskIds: ["local-two", "a", "c"],
      completedTaskIds: [],
    },
  ]);
  expect(requests.slice(crossStart).map((request) => request.method)).toEqual([
    "POST",
    "PATCH",
  ]);
  expect(read(tuesday.date)).toEqual({
    taskIds: ["local-one", "b", "done"],
    completed: ["done"],
  });
  expect(read(wednesday.date).taskIds).toEqual(["local-two", "a", "c"]);
  flows.set(thursday.date, { taskIds: ["local-unplanned"], completed: [] });
  const placed = await api.moveTaskToDay("d", undefined, thursday);
  expect(placed).toEqual([
    {
      date: thursday.date,
      taskIds: ["local-unplanned", "d"],
      completedTaskIds: [],
    },
  ]);
  expect(read(thursday.date).taskIds).toEqual(["local-unplanned", "d"]);

  const friday = initial.days.find((day) => day.date === "2026-10-16")!;
  const rolloverStart = requests.length;
  const withoutReorder = await api.moveTaskToDay("b", tuesday, friday);
  expect(withoutReorder).toEqual([
    {
      date: tuesday.date,
      taskIds: ["local-one", "done"],
      completedTaskIds: ["done"],
    },
    { date: friday.date, taskIds: ["b"], completedTaskIds: [] },
  ]);
  expect(
    requests.slice(rolloverStart).map((request) => request.method),
  ).toEqual(["POST"]);
  const noOpStart = requests.length;
  expect(await api.moveTaskToDay("b", friday, friday, "b")).toEqual([]);
  expect(requests).toHaveLength(noOpStart);

  // Another tab adds a step; one-step edits start from FlowDay's queue, so they keep it.
  flows.set(tuesday.date, {
    ...read(tuesday.date),
    taskIds: [...read(tuesday.date).taskIds, "local-other"],
  });
  const queueStart = requests.length;
  expect(await api.addToDay("local-extra", tuesday.date)).toEqual([
    {
      date: tuesday.date,
      taskIds: ["local-one", "done", "local-other", "local-extra"],
      completedTaskIds: ["done"],
    },
  ]);
  const removed = await api.removeFromDay("local-one", tuesday.date);
  expect(removed).toEqual([
    {
      date: tuesday.date,
      taskIds: ["done", "local-other", "local-extra"],
      completedTaskIds: ["done"],
    },
  ]);
  // A step already in the queue (or already removed) is not written again.
  expect(await api.addToDay("local-extra", tuesday.date)).toEqual(removed);
  expect(await api.removeFromDay("local-one", tuesday.date)).toEqual(removed);
  expect(requests.slice(queueStart).map((request) => request.method)).toEqual([
    "GET",
    "PATCH",
    "GET",
    "PATCH",
    "GET",
    "GET",
  ]);
  expect(
    requests
      .slice(mutationStart)
      .every((request) =>
        request.path.startsWith("/api/plus/flowday/api/v1/flows/"),
      ),
  ).toBe(true);
  const reloaded = await api.load();
  expect(
    reloaded.days.find((day) => day.date === wednesday.date)?.taskIds,
  ).toEqual(["local-two", "a", "c"]);
  expect(
    reloaded.plan.tasks.every(
      (task) => task.due === "2026-10-20" && task.deadline === "2026-10-30",
    ),
  ).toBe(true);
  expect(
    writes.every(
      (write) =>
        write.path.startsWith("/api/plus/flowday/") &&
        !Object.hasOwn(write.body, "due") &&
        !Object.hasOwn(write.body, "deadline"),
    ),
  ).toBe(true);
});

it("reads the FULL plan for the sidebar, which names the mail project to hide", async () => {
  const urls: URL[] = [];
  const api = createApi(
    { apiOrigin: "https://api.example.test", token: "synthetic" },
    async (input) => {
      urls.push(new URL(String(input)));
      return Response.json({
        plan: {
          week_start: "2026-10-12",
          today: "2026-10-13",
          timezone: "UTC",
          enabled: true,
          inbox_project_id: "mail-project",
        },
      });
    },
  );
  // The mail project's ID comes only with the FULL view, which a request without `view` asks for.
  expect((await api.readPlan()).inboxProjectId).toBe("mail-project");
  expect(urls.map((url) => [url.pathname, url.search])).toEqual([
    ["/api/plus/v1/plan:read", ""],
  ]);
});

it("answers the new steps' IDs, and after one FlowDay sync knows every task the latest read listed", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  // Todoist lists two new steps; FlowDay has neither yet and throttles a second manual sync.
  let listed = ["outcome", "step-1", "step-2"];
  let syncs = 0;
  const api = createApi(
    { apiOrigin: "https://api.example.test", token: "synthetic" },
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      requests.push({ path, body });
      const reply = (value: unknown) => Response.json(value);
      if (path === "/api/plus/v1/plan:read")
        return reply({
          plan: {
            week_start: "2026-10-12",
            today: "2026-10-13",
            timezone: "UTC",
            enabled: true,
          },
        });
      if (path === "/api/plus/v1/tasks:appendTaskSteps")
        return reply({ task_ids: ["step-1"] });
      if (path === "/api/plus/v1/tasks")
        return reply({
          planning_tasks: listed.map((id) => ({
            id,
            title: `Synthetic ${id}`,
          })),
        });
      if (path.endsWith("/tasks:sync"))
        return reply({ state: syncs++ ? "throttled" : "synced" });
      if (path.endsWith("/timerSession"))
        return reply({ name: "timerSession", etag: "0" });
      if (path.endsWith("/api/v1/tasks"))
        return reply({
          tasks: [{ name: "tasks/outcome", todoist_id: "outcome", title: "x" }],
        });
      const day = path.match(/\/flows\/(\d{4}-\d{2}-\d{2})/u)?.[1];
      if (!day) throw new Error(`Unexpected request: ${path}`);
      return reply({
        name: `flows/${day}`,
        task_ids: (body.task_ids as string[] | undefined) ?? [],
      });
    },
  );
  const outcome = (await api.load()).plan.tasks[0]!;
  expect(
    await api.createSteps(
      outcome,
      [{ title: "Synthetic step 1" }],
      "11111111-1111-4111-8111-111111111111",
    ),
  ).toEqual(["step-1"]);
  expect(requests.at(-1)).toEqual({
    path: "/api/plus/v1/tasks:appendTaskSteps",
    body: {
      parent_id: "outcome",
      request_id: "11111111-1111-4111-8111-111111111111",
      steps: [{ title: "Synthetic step 1" }],
    },
  });
  await api.load();
  // The first new step syncs FlowDay, which imports the second one in the same sync.
  await api.addToDay("step-1", "2026-10-13");
  await api.addToDay("step-2", "2026-10-14");
  expect(syncs).toBe(1);
  // A step that only a later read lists may be newer than that sync: it asks again.
  listed = [...listed, "step-3"];
  await api.load();
  await expect(api.addToDay("step-3", "2026-10-15")).rejects.toThrow(
    "FlowDay just synced",
  );
  expect(syncs).toBe(2);
});

it("maps Todoist's sibling order and the saved lane orders, and sends a reorder with the moved task", async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const api = createApi(
    { apiOrigin: "https://api.example.test", token: "synthetic" },
    async (input, init) => {
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
    },
  );
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
  const api = createApi(
    { apiOrigin: "https://api.example.test", token: "synthetic" },
    async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ task: { id: "a", title: "Synthetic a" } });
    },
  );
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
