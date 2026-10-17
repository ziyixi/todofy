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
  label_ids?: string[];
}
async function make(
  kind: string,
  body: Record<string, unknown>,
): Promise<Resource> {
  const response = await harness.mutate(
    "POST",
    `/api/tasks/v1/${kind}?request_id=${randomUUID()}`,
    body,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return response.json() as Promise<Resource>;
}
async function remove(resource: Resource, requestId = randomUUID()) {
  return harness.mutate(
    "DELETE",
    `/api/tasks/v1/${resource.name}?etag=${resource.etag}&request_id=${requestId}`,
  );
}
async function exists(resource: Resource) {
  return (await harness.fetch(`/api/tasks/v1/${resource.name}`)).status;
}

test("deleting a nonempty project removes its whole hierarchy and emits task tombstones once", async () => {
  const project = await make("projects", { title: "Synthetic parent project" });
  const nested = await make("projects", {
    title: "Nested project",
    parent_id: project.id,
  });
  const section = await make("sections", {
    title: "Nested section",
    project_id: nested.id,
  });
  const parent = await make("tasks", {
    title: "Parent task",
    project_id: nested.id,
    section_id: section.id,
  });
  const child = await make("tasks", {
    title: "Child task",
    parent_id: parent.id,
  });
  const outside = await make("tasks", { title: "Unrelated Inbox task" });
  const cursor = await harness.db
    .prepare("SELECT MAX(sequence) AS n FROM changes")
    .first<{ n: number }>();
  const id = randomUUID();
  expect((await remove(project, id)).status).toBe(200);
  expect(await exists(parent)).toBe(404);
  expect(await exists(child)).toBe(404);
  expect(await exists(outside)).toBe(200);
  const deleted = await harness.db
    .prepare(
      "SELECT resource_id FROM changes WHERE sequence>? AND resource=? AND deleted=1",
    )
    .bind(cursor?.n ?? 0, "tasks")
    .all<{ resource_id: string }>();
  expect(deleted.results.map((row) => row.resource_id).sort()).toEqual(
    [parent.id, child.id].sort(),
  );
  const count = await harness.db
    .prepare("SELECT COUNT(*) AS n FROM changes")
    .first<{ n: number }>();
  expect((await remove(project, id)).status).toBe(200);
  expect(
    await harness.db.prepare("SELECT COUNT(*) AS n FROM changes").first(),
  ).toEqual(count);
  const catalogResponse = await harness.fetch("/api/tasks/v1/catalog");
  expect(catalogResponse.status).toBe(200);
  const catalog = await catalogResponse.json() as { projects?: Resource[]; sections?: Resource[] };
  expect(
    (catalog.projects ?? []).some(
      (row) => row.id === project.id || row.id === nested.id,
    ),
  ).toBe(false);
  expect((catalog.sections ?? []).some((row) => row.id === section.id)).toBe(false);
});

test("deleting a section includes descendants and preserves tasks in other sections", async () => {
  const project = await make("projects", { title: "Section owner" });
  const section = await make("sections", {
    title: "To remove",
    project_id: project.id,
  });
  const other = await make("sections", {
    title: "To keep",
    project_id: project.id,
  });
  const parent = await make("tasks", {
    title: "Section parent",
    project_id: project.id,
    section_id: section.id,
  });
  const child = await make("tasks", {
    title: "Explicit child",
    parent_id: parent.id,
    project_id: project.id,
  });
  const outside = await make("tasks", {
    title: "Other section task",
    project_id: project.id,
    section_id: other.id,
  });
  expect((await remove(section)).status).toBe(200);
  expect(await exists(parent)).toBe(404);
  expect(await exists(child)).toBe(404);
  expect(await exists(outside)).toBe(200);
});

test("deleting a used label detaches it without deleting tasks or unrelated labels", async () => {
  const label = await make("labels", { title: "Remove me" });
  const other = await make("labels", { title: "Keep me" });
  const first = await make("tasks", {
    title: "Both labels",
    label_ids: [label.id, other.id],
  });
  const second = await make("tasks", {
    title: "One label",
    label_ids: [label.id],
  });
  expect((await remove(label)).status).toBe(200);
  const saved = (await (
    await harness.fetch(`/api/tasks/v1/${first.name}`)
  ).json()) as Resource;
  const savedSecond = (await (
    await harness.fetch(`/api/tasks/v1/${second.name}`)
  ).json()) as Resource;
  expect(saved.label_ids).toEqual([other.id]);
  expect(savedSecond.label_ids ?? []).toEqual([]);
  expect(saved.etag).not.toEqual(first.etag);
  expect(await exists(first)).toBe(200);
  expect(await exists(second)).toBe(200);
});
