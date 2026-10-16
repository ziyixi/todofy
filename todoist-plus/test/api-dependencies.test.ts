import { expect, it } from "vitest";
import { createApi, planningTask, publicError } from "../src/api";
import type { PlanningTask as ApiPlanningTask } from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";

/** A Todofy stub: the synthetic answers by path, with every request it received. */
function todofy(answers: Record<string, () => Response>) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const api = createApi(
    { apiOrigin: "https://api.example.test", token: "synthetic" },
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({
        path,
        body: init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : {},
      });
      const answer = answers[path];
      if (!answer) throw new Error(`Unexpected request: ${path}`);
      return answer();
    },
  );
  return { api, requests };
}
const refused = (reason: string, status: number) =>
  Response.json(
    {
      error: {
        code: status,
        message: "synthetic refusal",
        status: status === 404 ? "NOT_FOUND" : "FAILED_PRECONDITION",
        details: [
          {
            "@type": "type.googleapis.com/google.rpc.ErrorInfo",
            reason,
            domain: "todofy.ziyixi.science",
          },
        ],
      },
    },
    { status },
  );

it("maps the recurring flag, Todoist's counter and every dependency", async () => {
  const counted = planningTask({
    id: "a",
    recurring: true,
    completedCount: 4,
  } as ApiPlanningTask);
  expect([counted.recurring, counted.completedCount]).toEqual([true, 4]);
  // An absent counter stays absent, not zero.
  expect(
    planningTask({ id: "b", recurring: true } as ApiPlanningTask)
      .completedCount,
  ).toBeUndefined();
  const { api } = todofy({
    "/api/plus/v1/plan:read": () =>
      Response.json({
        plan: {
          week_start: "2026-10-12",
          today: "2026-10-13",
          timezone: "UTC",
          enabled: true,
          dependencies: [
            { task_id: "a", prerequisite_id: "b", baseline_completed_count: 2 },
            { task_id: "a", prerequisite_id: "c", done: true },
          ],
        },
      }),
  });
  expect((await api.readPlan()).dependencies).toEqual([
    { taskId: "a", prerequisiteId: "b", baselineCount: 2, done: false },
    { taskId: "a", prerequisiteId: "c", baselineCount: 0, done: true },
  ]);
});

it("sends one dependency write and one settling check, IDs only", async () => {
  const { api, requests } = todofy({
    "/api/plus/v1/tasks:setTaskDependency": () =>
      Response.json({ dependencies: [{ task_id: "a", prerequisite_id: "b" }] }),
    "/api/plus/v1/tasks:resolveDependencies": () =>
      Response.json({ dependencies: [], dropped_task_ids: ["a"] }),
  });
  expect(await api.setDependency("a", "b", true)).toEqual({
    forTask: "a",
    dependencies: [
      { taskId: "a", prerequisiteId: "b", baselineCount: 0, done: false },
    ],
  });
  expect(await api.resolveDependencies(["b", "c"])).toEqual({
    dependencies: [],
    dropped: ["a"],
  });
  expect(
    requests.map(({ path, body }) => [
      path,
      { ...body, request_id: typeof body.request_id },
    ]),
  ).toEqual([
    [
      "/api/plus/v1/tasks:setTaskDependency",
      { task_id: "a", prerequisite_id: "b", waits: true, request_id: "string" },
    ],
    [
      "/api/plus/v1/tasks:resolveDependencies",
      { task_ids: ["b", "c"], request_id: "string" },
    ],
  ]);
});

it("says why Todofy did not add a dependency", async () => {
  for (const [reason, status, message] of [
    [
      "ACTION_NOT_ALLOWED",
      400,
      "Not added: these tasks would wait on each other, or this task already waits for 5.",
    ],
    [
      "NOT_FOUND",
      404,
      "Not added: one of these tasks is no longer active. Refresh and try again.",
    ],
  ] as const) {
    const { api } = todofy({
      "/api/plus/v1/tasks:setTaskDependency": () => refused(reason, status),
    });
    const error = await api
      .setDependency("a", "b", true)
      .catch((failure: unknown) => failure);
    // The background passes on publicError's text, which keeps this one.
    expect(publicError(error)).toBe(message);
  }
});
