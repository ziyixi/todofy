import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
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
  title: string;
  description?: string;
  sort_order?: number;
  completed?: boolean;
  child_count?: number;
  completed_count?: number;
  dependencies?: { prerequisite_id: string; title: string }[];
  dependents?: { task_id: string; title: string }[];
}
async function make(
  kind: string,
  body: Record<string, unknown>,
  id: string = randomUUID(),
): Promise<Resource> {
  const idField =
    kind === "tasks"
      ? "task_id"
      : kind === "projects"
        ? "project_id"
        : kind === "sections"
          ? "section_id"
          : "label_id";
  const response = await harness.mutate(
    "POST",
    `/api/tasks/v1/${kind}?request_id=${randomUUID()}&${idField}=${id}`,
    body,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<Resource>;
}
async function copy(task: Resource, requestId = randomUUID()) {
  return harness.mutate("POST", `/api/tasks/v1/${task.name}:duplicate`, {
    etag: task.etag,
    request_id: requestId,
  });
}

test("duplicate and its frozen receipt exclude both directions of dependency links", async () => {
  const prerequisite = await make("tasks", {
    title: "Synthetic source prerequisite",
  });
  const source = await make("tasks", { title: "Synthetic dependency source" });
  const waiter = await make("tasks", { title: "Synthetic source dependent" });
  for (const [task, id] of [
    [source, prerequisite.id],
    [waiter, source.id],
  ] as const) {
    const response = await harness.mutate(
      "PATCH",
      `/api/tasks/v1/${task.name}?etag=${task.etag}&request_id=${randomUUID()}&update_mask=dependencies`,
      { dependencies: [{ prerequisite_id: id }] },
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  const current = await (
    await harness.fetch(`/api/tasks/v1/${source.name}`)
  ).json<Resource>();
  expect(current.dependencies).toEqual([
    { prerequisite_id: prerequisite.id, title: prerequisite.title },
  ]);
  expect(current.dependents).toEqual([
    { task_id: waiter.id, title: waiter.title },
  ]);
  const requestId = randomUUID();
  const response = await copy(current, requestId);
  expect(response.status, await response.clone().text()).toBe(200);
  const duplicate = await response.json<Resource>();
  expect(duplicate.dependencies ?? []).toEqual([]);
  expect(duplicate.dependents ?? []).toEqual([]);
  const read = await (
    await harness.fetch(`/api/tasks/v1/${duplicate.name}`)
  ).json<Resource>();
  expect(read.dependencies ?? []).toEqual([]);
  expect(read.dependents ?? []).toEqual([]);
  expect(await (await copy(current, requestId)).json()).toEqual(duplicate);
  const original = await (
    await harness.fetch(`/api/tasks/v1/${source.name}`)
  ).json<Resource>();
  expect(original.dependents).toEqual(current.dependents);
});

test.each(["task", "step"])(
  "duplicate refuses a completed %s under a completed parent",
  async (kind) => {
    const parent = await make("tasks", { title: "Synthetic completed parent" });
    const child = await make("tasks", {
      title: "Synthetic completed child",
      parent_id: parent.id,
      kind,
    });
    const completed = await harness.mutate(
      "POST",
      `/api/tasks/v1/${parent.name}:complete`,
      { etag: parent.etag, request_id: randomUUID() },
    );
    expect(completed.status, await completed.clone().text()).toBe(200);
    const current = await (
      await harness.fetch(`/api/tasks/v1/${child.name}`)
    ).json<Resource>();
    expect(current.completed).toBe(true);
    const before = await harness.db
      .prepare("SELECT count(*) AS n FROM tasks")
      .first();
    const request = randomUUID();
    const rejected = await copy(current, request);
    expect(rejected.status, await rejected.clone().text()).toBe(400);
    expect(await rejected.json()).toMatchObject({
      error: { status: "FAILED_PRECONDITION" },
    });
    expect(
      await harness.db.prepare("SELECT count(*) AS n FROM tasks").first(),
    ).toEqual(before);
    expect(
      await harness.db
        .prepare("SELECT id FROM requests WHERE id=?")
        .bind(request)
        .first(),
    ).toBeNull();
  },
);

test("duplicate preserves the active hierarchy and full fields below its source, with one frozen receipt", async () => {
  const project = await make("projects", {
    title: "Synthetic duplicate project",
  });
  const section = await make("sections", {
    title: "Synthetic duplicate section",
    project_id: project.id,
  });
  const label = await make("labels", { title: "SyntheticDuplicateLabel" });
  const source = await make(
    "tasks",
    {
      title: "Synthetic complete task template",
      description: "Full stored description. ".repeat(600),
      project_id: project.id,
      section_id: section.id,
      label_ids: [label.id],
      priority: 1,
      sort_order: 10,
      due_date: "2026-11-03",
      due_datetime: "2026-11-03T19:00:00Z",
      due_timezone: "America/Los_Angeles",
      deadline: "2026-11-30",
      duration_minutes: 75,
      recurrence: "every Tuesday",
    },
    "source-copy-root",
  );
  const before = await make(
    "tasks",
    {
      title: "Same-position preceding sibling",
      project_id: project.id,
      section_id: section.id,
      sort_order: 10,
    },
    "aaa-before-copy",
  );
  const after = await make(
    "tasks",
    {
      title: "Same-position following sibling",
      project_id: project.id,
      section_id: section.id,
      sort_order: 10,
    },
    "zzz-after-copy",
  );
  const later = await make("tasks", {
    title: "Fractional following sibling",
    project_id: project.id,
    section_id: section.id,
    sort_order: 10.2,
  });
  // The future grandchild predates its parent, so copying cannot rely on insertion order.
  const grandchild = await make("tasks", {
    title: "Synthetic active grandchild",
    description: "Grandchild detail",
    parent_id: source.id,
  });
  const child = await make("tasks", {
    title: "Synthetic active child",
    description: "Child detail",
    label_ids: [label.id],
    parent_id: source.id,
    duration_minutes: 30,
  });
  const reparent = await harness.mutate(
    "PATCH",
    `/api/tasks/v1/${grandchild.name}?etag=${grandchild.etag}&request_id=${randomUUID()}&update_mask=parent_id`,
    { parent_id: child.id },
  );
  expect(reparent.status).toBe(200);
  const complete = await make("tasks", {
    title: "Synthetic completed child",
    parent_id: source.id,
  });
  expect(
    (
      await harness.mutate("POST", `/api/tasks/v1/${complete.name}:complete`, {
        etag: complete.etag,
        request_id: randomUUID(),
      })
    ).status,
  ).toBe(200);
  await harness.db
    .prepare("UPDATE tasks SET completed_base_count=5 WHERE id IN (?,?)")
    .bind(source.id, child.id)
    .run();

  const requestId = randomUUID();
  const response = await copy(source, requestId);
  expect(response.status, await response.clone().text()).toBe(200);
  const duplicate = await response.json<Resource>();
  expect(duplicate.id).not.toBe(source.id);
  expect(duplicate).toMatchObject({
    title: source.title,
    description: source.description,
    project_id: project.id,
    section_id: section.id,
    label_ids: [label.id],
    priority: 1,
    sort_order: 10.5,
    due_date: "2026-11-03",
    due_datetime: "2026-11-03T19:00:00Z",
    due_timezone: "America/Los_Angeles",
    deadline: "2026-11-30",
    duration_minutes: 75,
    recurrence: "every Tuesday",
    etag: "1",
    child_count: 1,
  });
  expect(duplicate.completed ?? false).toBe(false);
  expect(duplicate.completed_count ?? 0).toBe(0);
  const copiedChildren = await harness.db
    .prepare("SELECT * FROM tasks WHERE parent_id=?")
    .bind(duplicate.id)
    .all();
  expect(copiedChildren.results).toHaveLength(1);
  const copiedChild = copiedChildren.results[0];
  if (!copiedChild) throw new Error("Copied child is missing");
  expect(copiedChild).toMatchObject({
    title: child.title,
    description: "Child detail",
    label_ids: JSON.stringify([label.id]),
    duration_minutes: 30,
    completed: 0,
    completed_base_count: 0,
    revision: 1,
  });
  expect(copiedChild.id).not.toBe(child.id);
  const copiedGrandchildren = await harness.db
    .prepare("SELECT * FROM tasks WHERE parent_id=?")
    .bind(copiedChild.id)
    .all();
  expect(copiedGrandchildren.results).toHaveLength(1);
  const copiedGrandchild = copiedGrandchildren.results[0];
  if (!copiedGrandchild) throw new Error("Copied grandchild is missing");
  expect(copiedGrandchild).toMatchObject({
    title: grandchild.title,
    description: "Grandchild detail",
    completed: 0,
  });
  expect(copiedGrandchild.id).not.toBe(grandchild.id);
  const history = await harness.db
    .prepare("SELECT count(*) n FROM completions WHERE task_id IN (?,?,?)")
    .bind(duplicate.id, copiedChild.id, copiedGrandchild.id)
    .first();
  expect(history).toEqual({ n: 0 });
  const siblings = await harness.db
    .prepare(
      "SELECT id FROM tasks WHERE project_id=? AND section_id=? AND parent_id='' ORDER BY sort_order,id",
    )
    .bind(project.id, section.id)
    .all<{ id: string }>();
  expect(siblings.results.map((row) => row.id)).toEqual([
    before.id,
    source.id,
    duplicate.id,
    after.id,
    later.id,
  ]);

  const changed = await harness.mutate(
    "PATCH",
    `/api/tasks/v1/${source.name}?etag=${source.etag}&request_id=${randomUUID()}&update_mask=title`,
    { title: "Edited after the original duplicate" },
  );
  expect(changed.status).toBe(200);
  const changes = await harness.db
    .prepare("SELECT count(*) n FROM changes")
    .first();
  expect(await (await copy(source, requestId)).json()).toEqual(duplicate);
  expect(
    await harness.db.prepare("SELECT count(*) n FROM changes").first(),
  ).toEqual(changes);
  expect((await copy(source)).status).toBe(409);
  expect(
    await harness.db.prepare("SELECT count(*) n FROM changes").first(),
  ).toEqual(changes);
});

test("duplicate bounds the active family without leaving a receipt or a partial copy", async () => {
  const source = await make("tasks", { title: "Synthetic bounded template" });
  const children = Array.from({ length: 100 }, (_, index) => ({
    id: `copy-limit-${String(index)}`,
    title: `Child ${String(index)}`,
  }));
  await harness.db
    .prepare(
      "INSERT INTO tasks(id,title,parent_id,created_at,updated_at) SELECT value->>'id',value->>'title',?,?,? FROM json_each(?)",
    )
    .bind(source.id, Date.now(), Date.now(), JSON.stringify(children))
    .run();
  const requestId = randomUUID();
  const count = await harness.db
    .prepare("SELECT count(*) n FROM tasks")
    .first();
  const rejected = await copy(source, requestId);
  expect(rejected.status, await rejected.clone().text()).toBe(400);
  expect(await rejected.text()).toContain("100");
  expect(
    await harness.db.prepare("SELECT count(*) n FROM tasks").first(),
  ).toEqual(count);
  expect(
    await harness.db
      .prepare("SELECT id FROM requests WHERE id=?")
      .bind(requestId)
      .first(),
  ).toBeNull();
  await harness.db
    .prepare("UPDATE tasks SET deleted_at=? WHERE id=?")
    .bind(Date.now(), "copy-limit-0")
    .run();
  const accepted = await copy(source, requestId);
  expect(accepted.status, await accepted.clone().text()).toBe(200);
  const duplicate = await accepted.json<Resource>();
  expect(duplicate.child_count).toBe(99);
  expect(
    (
      await harness.db
        .prepare("SELECT count(*) n FROM tasks WHERE parent_id=?")
        .bind(duplicate.id)
        .first<{ n: number }>()
    )?.n,
  ).toBe(99);
});
