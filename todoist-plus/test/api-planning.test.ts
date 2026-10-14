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

  const queueStart = requests.length;
  const updated = await api.updateQueue(
    ["local-one", "done", "local-extra"],
    withoutReorder[0]!,
  );
  expect(updated).toEqual([
    {
      date: tuesday.date,
      taskIds: ["local-one", "done", "local-extra"],
      completedTaskIds: ["done"],
    },
  ]);
  expect(requests.slice(queueStart).map((request) => request.method)).toEqual([
    "PATCH",
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
