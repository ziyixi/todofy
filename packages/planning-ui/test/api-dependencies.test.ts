import { expect, it } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import { planningTask } from "../src/api";
import { fakeActions } from "./transport";

/** A Tasks stub: the synthetic answers by method and path, with every request it received. */
function tasks(answers: Record<string, () => Response>) {
  const requests: {
    method: string;
    path: string;
    etag?: string;
    body: unknown;
  }[] = [];
  const api = fakeActions(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({
      method,
      path: url.pathname,
      ...(url.searchParams.has("etag")
        ? { etag: url.searchParams.get("etag")! }
        : {}),
      body: init?.body ? (JSON.parse(String(init.body)) as unknown) : undefined,
    });
    const answer = answers[`${method} ${url.pathname}`];
    if (!answer)
      throw new Error(`Unexpected request: ${method} ${url.pathname}`);
    return answer();
  });
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
            domain: "tasks.ziyixi.science",
          },
        ],
      },
    },
    { status },
  );
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
const held = planningTask(
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
  const { api, requests } = tasks({
    "PATCH /api/tasks/v1/tasks/a": () => Response.json(saved),
  });
  const result = await api.setDependencies(held, ["c", "b"], {
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
  await api.setDependencies(held, []);
  expect(requests.map((request) => request.path)).toEqual([
    "/api/tasks/v1/tasks/a",
  ]);
  expect(requests[0]?.body).toEqual({});
});

it("restarts a done dependency by removing it and adding it again, the second write under the first one's etag", async () => {
  let answer = 0;
  const { api, requests } = tasks({
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
  const result = await api.setDependencies(held, ["c"], {
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
    const { api } = tasks({
      "PATCH /api/tasks/v1/tasks/a": () => refused(reason, status),
    });
    const error = await api
      .setDependencies(held, ["c", "b"], { id: "b", restart: false })
      .catch((failure: unknown) => failure);
    // Plan shows a failed write's own message.
    expect((error as Error).message).toBe(message);
  }
});
