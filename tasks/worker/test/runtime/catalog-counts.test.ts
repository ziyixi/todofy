import { afterAll, beforeAll, expect, test } from "vitest";
import { localDate, addDays } from "@ziyixi/task-dates";
import { startHarness, type Harness } from "./harness.ts";

let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.dispose();
});

test("catalog counts match default task views, including subtasks, archive visibility and saved-filter predicates", async () => {
  const db = harness.db;
  const today = localDate(Date.now(), "America/Los_Angeles");
  await db.batch([
    db.prepare(
      "INSERT INTO projects(id,title,inbox,created_at,updated_at) VALUES('inbox','Inbox',1,1,1)",
    ),
    db.prepare(
      "INSERT INTO projects(id,title,created_at,updated_at) VALUES('studio','Synthetic studio',1,1)",
    ),
    db.prepare(
      "INSERT INTO projects(id,title,archived,created_at,updated_at) VALUES('archive','Synthetic archive',1,1,1)",
    ),
    db.prepare(
      "INSERT INTO labels(id,title,created_at,updated_at) VALUES('scope','Synthetic scope',1,1)",
    ),
    db.prepare(
      "INSERT INTO labels(id,title,created_at,updated_at) VALUES('empty','Synthetic empty',1,1)",
    ),
    db
      .prepare(
        "INSERT INTO filters(id,title,query,created_at,updated_at) VALUES('urgent','Synthetic urgent',?,1,1)",
      )
      .bind("@Synthetic scope & (today | p1)"),
  ]);
  const tasks = [
    {
      id: "unfiled",
      project: "",
      parent: "",
      date: "",
      priority: 4,
      archived: 0,
      completed: 0,
    },
    {
      id: "inbox-root",
      project: "inbox",
      parent: "",
      date: today,
      priority: 4,
      archived: 0,
      completed: 0,
    },
    {
      id: "studio-root",
      project: "studio",
      parent: "",
      date: addDays(today, -1),
      priority: 1,
      archived: 0,
      completed: 0,
    },
    {
      id: "studio-child",
      project: "studio",
      parent: "studio-root",
      date: today,
      priority: 4,
      archived: 0,
      completed: 0,
    },
    {
      id: "studio-next",
      project: "studio",
      parent: "",
      date: addDays(today, 7),
      priority: 4,
      archived: 0,
      completed: 0,
    },
    {
      id: "archived-root",
      project: "archive",
      parent: "",
      date: today,
      priority: 1,
      archived: 1,
      completed: 0,
    },
    {
      id: "done",
      project: "studio",
      parent: "",
      date: today,
      priority: 1,
      archived: 0,
      completed: 1,
    },
  ];
  for (const task of tasks) {
    await db
      .prepare(
        `INSERT INTO tasks(id,title,project_id,parent_id,due_date,priority,project_archived,completed,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,1,1)`,
      )
      .bind(
        task.id,
        task.id,
        task.project,
        task.parent,
        task.date,
        task.priority,
        task.archived,
        task.completed,
      )
      .run();
    await db
      .prepare("INSERT INTO task_labels(task_id,label_id) VALUES(?,?)")
      .bind(task.id, "scope")
      .run();
  }
  const response = await harness.fetch("/api/tasks/v1/catalog");
  expect(response.status, await response.clone().text()).toBe(200);
  const catalog = (await response.json()) as {
    task_counts: { view: string; id?: string; count?: number }[];
  };
  const count = (view: string, id = "") =>
    catalog.task_counts.find(
      (row) => row.view === view && (row.id ?? "") === id,
    )?.count ?? 0;
  expect(count("inbox")).toBe(2);
  expect(count("today")).toBe(3);
  expect(count("upcoming")).toBe(2);
  expect(count("project", "studio")).toBe(2);
  expect(count("label", "scope")).toBe(5);
  expect(count("label", "empty")).toBe(0);
  expect(count("filter", "urgent")).toBe(3);
  for (const row of catalog.task_counts) {
    const parameters = new URLSearchParams({
      view: row.view,
      page_size: "100",
    });
    if (["project", "label", "filter"].includes(row.view))
      parameters.set(`${row.view}_id`, row.id ?? "");
    const list = await harness.fetch(
      `/api/tasks/v1/tasks?${parameters.toString()}`,
    );
    expect(list.status, await list.clone().text()).toBe(200);
    const data = (await list.json()) as { tasks?: unknown[] };
    expect(row.count ?? 0, `${row.view}/${row.id ?? ""}`).toBe(
      (data.tasks ?? []).length,
    );
  }
});

test("saved-filter counts bind punctuation and batch across filter and parameter boundaries", async () => {
  const db = harness.db;
  await db
    .prepare(
      "INSERT INTO labels(id,title,created_at,updated_at) VALUES('punctuation',?,1,1)",
    )
    .bind("Synthetic owner's work")
    .run();
  await db
    .prepare(
      "INSERT INTO task_labels(task_id,label_id) VALUES('studio-root','punctuation')",
    )
    .run();
  const query =
    "@Synthetic owner's work & (p1 | p2 | p3 | p4 | today | no date)";
  await db.batch(
    Array.from({ length: 25 }, (_, index) =>
      db
        .prepare(
          "INSERT INTO filters(id,title,query,created_at,updated_at) VALUES(?,?,?,1,1)",
        )
        .bind(
          `batched-${String(index)}`,
          `Synthetic batch ${String(index)}`,
          query,
        ),
    ),
  );
  const response = await harness.fetch("/api/tasks/v1/catalog");
  expect(response.status, await response.clone().text()).toBe(200);
  const data = (await response.json()) as {
    task_counts: { view: string; id?: string; count?: number }[];
  };
  const matches = data.task_counts.filter(
    (row) => row.view === "filter" && row.id?.startsWith("batched-"),
  );
  expect(matches).toHaveLength(25);
  expect(matches.every((row) => row.count === 1)).toBe(true);
});
