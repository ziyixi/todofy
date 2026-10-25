/** Synthetic GTD reporting over workerd's actual D1, including retained membership and bounded read paths. */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import {
  CreateTaskRequestSchema,
  GetGtdReportRequestSchema,
  UpdateTaskRequestSchema,
} from "@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb";
import { getGtdReport, REPORT_TASKS } from "../../src/gtd-report.ts";
import { createTask, updateTask } from "../../src/task-write.ts";
import { measuredReads, startHarness, type Harness } from "./harness.ts";

const ZONE = "America/Los_Angeles";
const at = (day: string) => Date.parse(`${day}T20:00:00Z`);
let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.dispose();
});
beforeEach(async () => {
  for (const table of [
    "day_steps",
    "focus_entries",
    "completions",
    "gtd_week_commitments",
    "requests",
    "tasks",
  ])
    await harness.db.prepare(`DELETE FROM ${table}`).run();
  await harness.db
    .prepare("UPDATE gtd_reporting SET started_at=?")
    .bind(at("2030-10-01"))
    .run();
});

function report(
  start = "2030-11-01",
  end = "2030-11-07",
  area = "",
  db = harness.db,
) {
  return getGtdReport(
    db,
    create(GetGtdReportRequestSchema, {
      name: "gtdReport",
      startDay: start,
      endDay: end,
      area,
    }),
    ZONE,
    at(end),
  );
}
async function fixture() {
  await harness.db.exec(
    `INSERT INTO tasks(id,title,kind,parent_id,area,planning_flags,duration_minutes,completed,created_at,updated_at) VALUES
    ('parent','Synthetic outcome','task','','work','[]',90,0,1,1),
    ('step','Synthetic action','step','parent','personal','[]',25,1,1,1),
    ('other-step','Synthetic open action','step','parent','work','[]',15,0,1,1),
    ('quick','Synthetic quick task','task','','work','["quick","task"]',10,1,1,1),
    ('routine','Synthetic routine','task','','work','["routine"]',20,0,1,1);
    INSERT INTO gtd_week_commitments(week_start,task_id,created_at) VALUES
      ('2030-10-28','parent',1),('2030-11-04','parent',2),('2030-11-04','routine',2);
    INSERT INTO day_steps(day,task_id,position,created_at,updated_at,deleted_at) VALUES
      ('2030-11-01','step',1,1,1,2),('2030-11-02','step',1,1,1,NULL),
      ('2030-11-02','other-step',2,1,1,NULL),('2030-11-02','quick',3,1,1,NULL);
    INSERT INTO focus_entries(id,task_id,day,seconds,source,area,created_at,updated_at) VALUES
      ('work','step','2030-11-01',1200,'manual','work',1,1),
      ('personal','step','2030-11-02',600,'manual','personal',1,1),
      ('routine-time','routine','2030-11-03',300,'manual','',1,1),
      ('outside','parent','2030-10-31',600,'manual','work',1,1);`.replace(
      /\n/g,
      " ",
    ),
  );
  for (const [id, task, when] of [
    ["parent-done", "parent", at("2030-11-01")],
    ["step-done", "step", at("2030-11-02")],
    ["quick-done", "quick", at("2030-11-03")],
    ["routine-done", "routine", at("2030-11-04")],
    ["unknown-done", "unavailable-import", at("2030-11-04")],
    ["before-midnight", "quick", Date.parse("2030-11-01T06:59:59Z")],
    ["after-midnight", "quick", Date.parse("2030-11-08T08:00:00Z")],
  ] as const)
    await harness.db
      .prepare(
        "INSERT INTO completions(id,task_id,title,completed_at) VALUES(?,?,?,?)",
      )
      .bind(id, task, "Synthetic completion", when)
      .run();
}

test("Task, literal Step and Routine totals retain hierarchy, estimates and true date bounds across DST", async () => {
  await fixture();
  const result = await report();
  expect(result).toMatchObject({
    taskCompletionCount: 2,
    stepCompletionCount: 1,
    routineCompletionCount: 1,
    unclassifiedCompletionCount: 1,
    taskPlanHistoryComplete: true,
    plannedTaskCount: 1,
    completedPlannedTaskCount: 1,
    plannedStepCount: 2,
    completedPlannedStepCount: 1,
    recordedSeconds: 2100,
    workSeconds: 1200,
    personalSeconds: 600,
    unassignedSeconds: 300,
    routineRecordedSeconds: 300,
  });
  expect(result.days).toHaveLength(7);
  expect(
    result.days.find((day) => day.day === "2030-11-03")?.taskCompletionCount,
  ).toBe(1);
  expect(result.tasks.find((task) => task.taskId === "parent")).toMatchObject({
    durationMinutes: 90,
    stepCount: 2,
    completedStepCount: 1,
    recordedSeconds: 0,
  });
  expect(result.tasks.find((task) => task.taskId === "step")).toMatchObject({
    kind: "step",
    parentId: "parent",
    parentTitle: "Synthetic outcome",
    parentDurationMinutes: 90,
    durationMinutes: 25,
    recordedSeconds: 1800,
    lastCompletedDay: "2030-11-02",
    planned: true,
  });
  expect(result.tasks.find((task) => task.taskId === "quick")).toMatchObject({
    kind: "task",
    planned: false,
  });
  expect(result.tasks.find((task) => task.taskId === "routine")?.planned).toBe(
    false,
  );
});

test("area filtering uses current task classification and each time record saved area", async () => {
  await fixture();
  const result = await report("2030-11-01", "2030-11-07", "work");
  expect(result).toMatchObject({
    taskCompletionCount: 2,
    stepCompletionCount: 0,
    routineCompletionCount: 1,
    unclassifiedCompletionCount: 0,
    recordedSeconds: 1200,
    workSeconds: 1200,
    personalSeconds: 0,
    plannedTaskCount: 1,
    plannedStepCount: 1,
    completedPlannedStepCount: 0,
  });
  expect(result.tasks.find((task) => task.taskId === "step")).toMatchObject({
    area: "personal",
    recordedSeconds: 1200,
    completionCount: 0,
  });
  // Current properties intentionally classify earlier activity too.
  await harness.db
    .prepare("UPDATE tasks SET planning_flags='[\"routine\"]' WHERE id='quick'")
    .run();
  expect(await report()).toMatchObject({
    taskCompletionCount: 1,
    routineCompletionCount: 2,
  });
});

test("unassigned Steps and nested Subtasks inherit the nearest current area while time keeps its saved area", async () => {
  await fixture();
  await harness.db
    .prepare("UPDATE tasks SET area='unassigned' WHERE id='step'")
    .run();
  await harness.db
    .prepare(
      `INSERT INTO tasks(id,title,parent_id,kind,created_at,updated_at) VALUES
    ('subtask','Synthetic nested outcome','parent','task',1,1),
    ('nested-step','Synthetic nested action','subtask','step',1,1)`,
    )
    .run();
  await harness.db
    .prepare(
      "INSERT INTO gtd_week_commitments(week_start,task_id,created_at) VALUES('2030-11-04','subtask',1)",
    )
    .run();
  await harness.db
    .prepare(
      "INSERT INTO day_steps(day,task_id,position,created_at,updated_at) VALUES('2030-11-02','nested-step',4,1,1)",
    )
    .run();
  await harness.db
    .prepare(
      `INSERT INTO completions(id,task_id,title,completed_at)
    SELECT id,id,title,? FROM tasks WHERE id IN ('subtask','nested-step')`,
    )
    .bind(at("2030-11-02"))
    .run();
  const work = await report("2030-11-01", "2030-11-07", "work");
  expect(work).toMatchObject({
    taskCompletionCount: 3,
    stepCompletionCount: 2,
    plannedTaskCount: 2,
    completedPlannedTaskCount: 2,
    plannedStepCount: 3,
    completedPlannedStepCount: 2,
    recordedSeconds: 1200,
  });
  for (const id of ["step", "subtask", "nested-step"])
    expect(work.tasks.find((task) => task.taskId === id)?.area).toBe("work");
  // The nearer override takes precedence, and later changes still do not rewrite saved time's area.
  await harness.db
    .prepare("UPDATE tasks SET area='personal' WHERE id='subtask'")
    .run();
  const personal = await report("2030-11-01", "2030-11-07", "personal");
  expect(personal).toMatchObject({
    taskCompletionCount: 1,
    stepCompletionCount: 1,
    plannedTaskCount: 1,
    plannedStepCount: 1,
    recordedSeconds: 600,
  });
  expect(
    personal.tasks.find((task) => task.taskId === "nested-step")?.area,
  ).toBe("personal");
});

test("Steps of a Routine parent are excluded from main metrics without changing their saved flags", async () => {
  await fixture();
  await harness.db
    .prepare(`UPDATE tasks SET planning_flags='["routine"]' WHERE id='parent'`)
    .run();
  const result = await report();
  expect(result).toMatchObject({
    taskCompletionCount: 1,
    stepCompletionCount: 0,
    routineCompletionCount: 3,
    plannedTaskCount: 0,
    plannedStepCount: 0,
    routineRecordedSeconds: 2100,
  });
  expect(result.tasks.find((task) => task.taskId === "step")?.routine).toBe(
    true,
  );
  expect(
    (
      await harness.db
        .prepare("SELECT planning_flags FROM tasks WHERE id='step'")
        .first<{ planning_flags: string }>()
    )?.planning_flags,
  ).toBe("[]");
});

test("older and first partial commitment periods expose counts without inventing a Task rate", async () => {
  await fixture();
  await harness.db
    .prepare("UPDATE gtd_reporting SET started_at=?")
    .bind(at("2030-11-02"))
    .run();
  const result = await report();
  expect(result.taskPlanHistoryComplete).toBe(false);
  expect(result.plannedTaskCount).toBeUndefined();
  expect(result.completedPlannedTaskCount).toBeUndefined();
  expect(result.stepCompletionCount).toBe(1);
  expect(
    (await report("2030-11-04", "2030-11-10")).taskPlanHistoryComplete,
  ).toBe(true);
});

test("create/update capture each committed week atomically and replay does not duplicate membership", async () => {
  let task = await createTask(
    harness.db,
    create(CreateTaskRequestSchema, {
      requestId: randomUUID(),
      task: create(TaskSchema, {
        title: "Synthetic committed outcome",
        stage: "committed",
      }),
    }),
    at("2030-11-04"),
    ZONE,
  );
  const update = (stage: string, day: string) => {
    const input = create(UpdateTaskRequestSchema, {
      requestId: randomUUID(),
      etag: task.etag,
      task: create(TaskSchema, { name: task.name, stage }),
      updateMask: { paths: ["stage"] },
    });
    return { input, day };
  };
  const leave = update("weekly", "2030-11-05");
  task = await updateTask(harness.db, leave.input, at(leave.day), ZONE);
  const next = update("committed", "2030-11-10"); // Sunday commits to next week.
  task = await updateTask(harness.db, next.input, at(next.day), ZONE);
  await updateTask(harness.db, next.input, at(next.day), ZONE);
  const memberships = await harness.db
    .prepare(
      "SELECT week_start FROM gtd_week_commitments WHERE task_id=? ORDER BY week_start",
    )
    .bind(task.id)
    .all<{ week_start: string }>();
  expect(memberships.results.map((row) => row.week_start)).toEqual([
    "2030-11-04",
    "2030-11-11",
  ]);
});

test("report details are bounded while aggregate totals include every activity row and soft-deleted task", async () => {
  const ids = JSON.stringify(
    Array.from({ length: REPORT_TASKS + 25 }, (_, index) => index),
  );
  await harness.db
    .prepare(
      "INSERT INTO tasks(id,title,area,created_at,updated_at) SELECT 'bounded-'||value,'Synthetic bounded task','work',1,1 FROM json_each(?)",
    )
    .bind(ids)
    .run();
  await harness.db
    .prepare(
      "INSERT INTO completions(id,task_id,title,completed_at) SELECT id,id,title,? FROM tasks",
    )
    .bind(at("2030-11-01"))
    .run();
  await harness.db
    .prepare("UPDATE tasks SET deleted_at=2 WHERE id='bounded-0'")
    .run();
  const result = await report();
  expect(result.tasks).toHaveLength(REPORT_TASKS);
  expect(result.tasksTruncated).toBe(true);
  expect(result.taskCompletionCount).toBe(REPORT_TASKS + 25);
});

test("the generated HTTP route returns the typed bounded report", async () => {
  await fixture();
  const response = await harness.fetch(
    "/api/tasks/v1/gtdReport?start_day=2030-11-01&end_day=2030-11-07",
  );
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({
    name: "gtdReport",
    task_completion_count: 2,
    recorded_seconds: 2100,
  });
});

test("date, area and singleton validation reject unbounded or ambiguous reads", async () => {
  const current = await getGtdReport(
    harness.db,
    create(GetGtdReportRequestSchema, { name: "gtdReport" }),
    ZONE,
    at("2030-11-07"),
  );
  expect([current.startDay, current.endDay]).toEqual([
    "2030-11-04",
    "2030-11-10",
  ]);
  await expect(report("2030-11-01", "2030-12-02")).rejects.toThrow("1 to 31");
  await expect(report("2030-11-02", "2030-11-01")).rejects.toThrow("1 to 31");
  await expect(report("2030-02-30", "2030-03-01")).rejects.toThrow(
    "YYYY-MM-DD",
  );
  await expect(report("2030-11-01", "2030-11-02", "other")).rejects.toThrow(
    "Area",
  );
  await expect(
    getGtdReport(
      harness.db,
      create(GetGtdReportRequestSchema, { name: "wrong" }),
      ZONE,
      0,
    ),
  ).rejects.toThrow("named");
});

test("range indexes keep unrelated completion, time and membership history out of a small report", async () => {
  await fixture();
  const ids = JSON.stringify(Array.from({ length: 3000 }, (_, index) => index));
  await harness.db
    .prepare(
      "INSERT INTO completions(id,task_id,title,completed_at) SELECT 'old-'||value,'parent','Synthetic old completion',1 FROM json_each(?)",
    )
    .bind(ids)
    .run();
  await harness.db
    .prepare(
      "INSERT INTO focus_entries(id,task_id,day,seconds,source,created_at,updated_at) SELECT 'old-'||value,'parent','2029-01-01',60,'manual',1,1 FROM json_each(?)",
    )
    .bind(ids)
    .run();
  await harness.db
    .prepare(
      "INSERT INTO gtd_week_commitments(week_start,task_id,created_at) SELECT '2029-01-01','old-'||value,1 FROM json_each(?)",
    )
    .bind(ids)
    .run();
  const measured = measuredReads(harness.db);
  expect(
    (await report("2030-11-01", "2030-11-07", "", measured.db))
      .taskCompletionCount,
  ).toBe(2);
  expect(measured.metrics.rowsRead).toBeLessThan(600);
});
