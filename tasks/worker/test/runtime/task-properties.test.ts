import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { URL } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { fromWire } from "@ziyixi/proto/wire-json";
import {
  CreateTaskRequestSchema,
  UpdateTaskRequestSchema,
} from "@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb";
import { fingerprint } from "../../src/receipts.ts";
import { startHarness, type Harness } from "./harness.ts";

let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.dispose();
});

interface Resource {
  id: string;
  name: string;
  etag: string;
  kind: string;
  effort?: string;
  parent_id?: string;
}
async function make(fields: Record<string, unknown>): Promise<Resource> {
  const response = await harness.mutate(
    "POST",
    `/api/tasks/v1/tasks?request_id=${randomUUID()}`,
    fields,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<Resource>;
}
async function patch(task: Resource, fields: Record<string, unknown>) {
  return harness.mutate(
    "PATCH",
    `/api/tasks/v1/${task.name}?etag=${task.etag}&request_id=${randomUUID()}&update_mask=${Object.keys(fields).join(",")}`,
    fields,
  );
}

test("task properties migration preserves imported identities, timed data, receipts and completion history", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      readFileSync(
        new URL("../../../migrations/0001_tasks.sql", import.meta.url),
        "utf8",
      ),
    );
    db.exec(
      "INSERT INTO tasks(id,title,due_date,due_datetime,due_timezone,duration_minutes,revision,created_at,updated_at) VALUES('imported','Existing task','2026-10-20','2026-10-20T19:00:00Z','America/Los_Angeles',90,4,1,2)",
    );
    db.exec(
      "INSERT INTO requests(id,fingerprint,response,created_at,revision_guard) VALUES('old-action','synthetic','{}',1,1)",
    );
    db.exec(
      "INSERT INTO completions(id,task_id,title,completed_at) VALUES('old-history','imported','Existing completed task',1)",
    );
    const previous = db.prepare("SELECT * FROM tasks").get();
    const receipt = db.prepare("SELECT * FROM requests").get();
    const history = db.prepare("SELECT * FROM completions").get();
    const changes = db.prepare("SELECT * FROM changes").all();
    db.exec(
      readFileSync(
        new URL(
          "../../../migrations/0003_task_properties.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(db.prepare("SELECT * FROM tasks").get()).toEqual({
      ...previous,
      kind: "task",
      effort: "",
    });
    expect(db.prepare("SELECT * FROM requests").get()).toEqual(receipt);
    expect(db.prepare("SELECT * FROM completions").get()).toEqual(history);
    expect(db.prepare("SELECT * FROM changes").all()).toEqual(changes);
    expect(() => {
      db.exec("UPDATE tasks SET kind='step' WHERE id='imported'");
    }).toThrow();
    expect(() => {
      db.exec("UPDATE tasks SET effort='unknown' WHERE id='imported'");
    }).toThrow();
  } finally {
    db.close();
  }
});

test("ordinary subtasks and steps retain their type and effort through reads, changes, copying and partial edits", async () => {
  const parent = await make({ title: "Synthetic goal", effort: "deep" });
  const subtask = await make({
    title: "Synthetic ordinary subtask",
    parent_id: parent.id,
  });
  const step = await make({
    title: "Synthetic timed step",
    parent_id: subtask.id,
    kind: "step",
    effort: "shallow",
    due_date: "2026-10-20",
    due_datetime: "2026-10-20T19:00:00Z",
    due_timezone: "America/Los_Angeles",
    duration_minutes: 45,
  });
  expect(parent.kind).toBe("task");
  expect(subtask.kind).toBe("task");
  expect(
    await (await harness.fetch(`/api/tasks/v1/${step.name}`)).json(),
  ).toMatchObject({
    kind: "step",
    effort: "shallow",
    parent_id: subtask.id,
    duration_minutes: 45,
    due_datetime: "2026-10-20T19:00:00Z",
  });
  const children = await (
    await harness.fetch(`/api/tasks/v1/tasks?parent_id=${subtask.id}`)
  ).json<{ tasks: Resource[] }>();
  expect(children.tasks).toContainEqual(
    expect.objectContaining({ id: step.id, kind: "step", effort: "shallow" }),
  );
  const changes = await (
    await harness.fetch("/api/tasks/v1/changes?page_size=100")
  ).json<{ changes: { task?: Resource }[] }>();
  expect(
    changes.changes.some(
      ({ task }) =>
        task?.id === step.id &&
        task.kind === "step" &&
        task.effort === "shallow",
    ),
  ).toBe(true);

  const renamed = await patch(step, { title: "Renamed synthetic step" });
  expect(renamed.status, await renamed.clone().text()).toBe(200);
  const saved = await renamed.json<Resource>();
  expect(saved).toMatchObject({ kind: "step", effort: "shallow" });
  const changedEffort = await patch(saved, { effort: "deep" });
  expect(changedEffort.status, await changedEffort.clone().text()).toBe(200);
  expect(await changedEffort.json()).toMatchObject({
    kind: "step",
    effort: "deep",
  });

  const copied = await harness.mutate(
    "POST",
    `/api/tasks/v1/${parent.name}:duplicate`,
    { etag: parent.etag, request_id: randomUUID() },
  );
  expect(copied.status, await copied.clone().text()).toBe(200);
  const duplicate = await copied.json<Resource>();
  expect(duplicate).toMatchObject({ kind: "task", effort: "deep" });
  const copiedChild = await harness.db
    .prepare("SELECT id,kind FROM tasks WHERE parent_id=?")
    .bind(duplicate.id)
    .first<{ id: string; kind: string }>();
  expect(copiedChild?.kind).toBe("task");
  const copiedStep = await harness.db
    .prepare(
      "SELECT kind,effort,duration_minutes,due_datetime FROM tasks WHERE parent_id=?",
    )
    .bind(copiedChild?.id)
    .first();
  expect(copiedStep).toEqual({
    kind: "step",
    effort: "deep",
    duration_minutes: 45,
    due_datetime: "2026-10-20T19:00:00Z",
  });
});

test("steps need a task parent and cannot own children; explicit type and effort updates remain editable", async () => {
  const parent = await make({ title: "Synthetic property parent" });
  const subtask = await make({
    title: "Synthetic child",
    parent_id: parent.id,
  });
  for (const fields of [
    { kind: "unknown" },
    { effort: "unknown" },
    { kind: "step" },
  ]) {
    const response = await harness.mutate(
      "POST",
      `/api/tasks/v1/tasks?request_id=${randomUUID()}`,
      { title: "Invalid synthetic property", ...fields },
    );
    expect(response.status).toBe(400);
  }
  expect(
    (await patch(parent, { kind: "step", parent_id: subtask.id })).status,
  ).toBe(400);
  const stepResponse = await patch(subtask, { kind: "step", effort: "deep" });
  expect(stepResponse.status, await stepResponse.clone().text()).toBe(200);
  const step = await stepResponse.json<Resource>();
  expect((await patch(step, { parent_id: "" })).status).toBe(400);
  const childOfStep = await harness.mutate(
    "POST",
    `/api/tasks/v1/tasks?request_id=${randomUUID()}`,
    { title: "Cannot nest under a step", parent_id: step.id },
  );
  expect(childOfStep.status).toBe(400);
  const moved = await patch(step, { kind: "task", parent_id: "", effort: "" });
  expect(moved.status, await moved.clone().text()).toBe(200);
  expect(await moved.json()).toMatchObject({ kind: "task" });
  expect(
    await harness.db
      .prepare("SELECT kind,effort,parent_id FROM tasks WHERE id=?")
      .bind(step.id)
      .first(),
  ).toEqual({ kind: "task", effort: "", parent_id: "" });

  const outer = await make({ title: "Synthetic outer task" });
  const branch = await make({ title: "Synthetic branch", parent_id: outer.id });
  await make({ title: "Existing child retained", parent_id: branch.id });
  const rejected = await patch(branch, { kind: "step" });
  expect(rejected.status).toBe(400);
  expect(await rejected.text()).toContain("children");
});

test("create and edit receipts from before task properties existed replay without changing tasks", async () => {
  const task = await make({ title: "Synthetic old receipt task" });
  const requestId = randomUUID();
  const createInput = fromWire(CreateTaskRequestSchema, {
    task: { title: "Synthetic legacy create" },
    request_id: requestId,
  }).message;
  const typed = createInput.task;
  if (!typed) throw new Error("Synthetic create task is missing");
  const oldShape = Object.fromEntries(
    Object.entries(typed).filter(([key]) => key !== "kind" && key !== "effort"),
  );
  const hash = await fingerprint("createTask", {
    ...createInput,
    task: oldShape,
  });
  const previous = {
    name: task.name,
    id: task.id,
    title: "Synthetic legacy create",
    etag: task.etag,
  };
  await harness.db
    .prepare(
      "INSERT INTO requests(id,fingerprint,response,created_at,revision_guard) VALUES(?,?,?,?,1)",
    )
    .bind(requestId, hash, JSON.stringify(previous), 1)
    .run();
  const replay = await harness.mutate(
    "POST",
    `/api/tasks/v1/tasks?request_id=${requestId}`,
    { title: typed.title },
  );
  expect(replay.status, await replay.clone().text()).toBe(200);
  expect(await replay.json()).toMatchObject(previous);
  expect(
    (
      await harness.mutate(
        "POST",
        `/api/tasks/v1/tasks?request_id=${requestId}`,
        { title: typed.title, effort: "deep" },
      )
    ).status,
  ).toBe(400);

  const updateId = randomUUID();
  const updateInput = fromWire(UpdateTaskRequestSchema, {
    task: { name: task.name, title: "Synthetic legacy edit" },
    etag: task.etag,
    request_id: updateId,
    update_mask: "title",
  }).message;
  const updateTask = updateInput.task;
  if (!updateTask) throw new Error("Synthetic update task is missing");
  const oldUpdate = Object.fromEntries(
    Object.entries(updateTask).filter(
      ([key]) => key !== "kind" && key !== "effort",
    ),
  );
  const updateHash = await fingerprint("updateTask", {
    ...updateInput,
    task: oldUpdate,
  });
  await harness.db
    .prepare(
      "INSERT INTO requests(id,fingerprint,response,created_at,revision_guard) VALUES(?,?,?,?,1)",
    )
    .bind(updateId, updateHash, JSON.stringify(previous), 1)
    .run();
  const before = await harness.db
    .prepare("SELECT * FROM tasks WHERE id=?")
    .bind(task.id)
    .first();
  const edited = await harness.mutate(
    "PATCH",
    `/api/tasks/v1/${task.name}?etag=${task.etag}&request_id=${updateId}&update_mask=title`,
    { title: updateTask.title },
  );
  expect(edited.status, await edited.clone().text()).toBe(200);
  expect(await edited.json()).toMatchObject(previous);
  expect(
    await harness.db
      .prepare("SELECT * FROM tasks WHERE id=?")
      .bind(task.id)
      .first(),
  ).toEqual(before);
});
