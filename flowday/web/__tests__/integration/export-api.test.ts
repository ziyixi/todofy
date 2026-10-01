import { describe, it, expect, beforeEach } from "vitest";
import { createTimeEntry } from "@/lib/db/queries/entries";
import { addCompletedFlowTask, setFlowTaskIds } from "@/lib/db/queries/flows";
import { upsertTasks } from "@/lib/db/queries/tasks";
import type { Task } from "@/lib/types/task";
import { buildMiscTaskId } from "@/lib/utils/misc-task";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? "t1",
    todoistId: null,
    title: "Test Task",
    description: null,
    projectName: "Work",
    projectColor: "#ff0000",
    priority: 1,
    labels: [],
    estimatedMins: 30,
    isCompleted: false,
    completedAt: null,
    dueDate: null,
    createdAt: null,
    syncedAt: null,
    deletedAt: null,
    ...overrides,
  } as Task;
}

async function callExport(params: string) {
  const mod = await import("@/app/api/export/route");
  const url = `http://localhost:3000/api/export?${params}`;
  return mod.GET(new Request(url));
}

describe("GET /api/export", () => {
  beforeEach(() => {
    upsertTasks([makeTask({ id: "t1", title: "Design", estimatedMins: 30 })]);
    setFlowTaskIds("2026-04-13", ["t1"]);
    addCompletedFlowTask("2026-04-13", "t1");
    createTimeEntry({
      id: "e1",
      taskId: "t1",
      flowDate: "2026-04-13",
      startTime: "2026-04-13T09:00:00Z",
      endTime: "2026-04-13T09:30:00Z",
      durationS: 1800,
      source: "timer",
    });
  });

  it("returns 400 without date params", async () => {
    const res = await callExport("type=entries&format=csv");
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid format", async () => {
    const res = await callExport("type=entries&format=xml&start=2026-04-13&end=2026-04-13");
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid type", async () => {
    const res = await callExport("type=invalid&format=csv&start=2026-04-13&end=2026-04-13");
    expect(res.status).toBe(400);
  });

  it("exports entries as JSON", async () => {
    const res = await callExport("type=entries&format=json&start=2026-04-13&end=2026-04-13");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].taskTitle).toBe("Design");
    expect(data[0].durationMins).toBe(30);
  });

  it("exports entries as CSV", async () => {
    const res = await callExport("type=entries&format=csv&start=2026-04-13&end=2026-04-13");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("date,taskId,taskTitle");
    expect(text).toContain("Design");
  });

  it("quotes CSV fields that contain commas or quotes in entries exports", async () => {
    upsertTasks([
      makeTask({
        id: "csv-entries-task",
        title: 'Roadmap, "Q2"',
        projectName: 'Docs, "Team"',
      }),
    ]);
    createTimeEntry({
      id: "csv-entries-entry",
      taskId: "csv-entries-task",
      flowDate: "2026-04-13",
      startTime: "2026-04-13T09:45:00Z",
      endTime: "2026-04-13T10:15:00Z",
      durationS: 1800,
      source: "manual",
    });

    const res = await callExport("type=entries&format=csv&start=2026-04-13&end=2026-04-13");
    expect(res.headers.get("content-disposition")).toContain(
      'flowday-entries-2026-04-13-to-2026-04-13.csv'
    );
    const text = await res.text();
    expect(text).toContain('"Roadmap, ""Q2"""');
    expect(text).toContain('"Docs, ""Team"""');
  });

  it("exports flows as JSON", async () => {
    const res = await callExport("type=flows&format=json&start=2026-04-13&end=2026-04-13");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].completed).toBe(true);
    expect(data[0].loggedMins).toBe(30);
    expect(data[0].estimatedMins).toBe(30);
  });

  it("exports flows as CSV", async () => {
    const res = await callExport("type=flows&format=csv&start=2026-04-13&end=2026-04-13");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("date,taskId,taskTitle");
    expect(text).toContain("true");
  });

  it("quotes CSV fields and uses the expected filename for flow exports", async () => {
    upsertTasks([
      makeTask({
        id: "csv-flow-task",
        title: 'Review, "Launch"',
        projectName: 'Ops, "Team"',
      }),
    ]);
    setFlowTaskIds("2026-04-13", ["csv-flow-task"]);

    const res = await callExport("type=flows&format=csv&start=2026-04-13&end=2026-04-13");
    expect(res.headers.get("content-disposition")).toContain(
      'flowday-flows-2026-04-13-to-2026-04-13.csv'
    );
    const text = await res.text();
    expect(text).toContain('"Review, ""Launch"""');
    expect(text).toContain('"Ops, ""Team"""');
  });

  it("returns empty array for date range with no data", async () => {
    const res = await callExport("type=entries&format=json&start=2020-01-01&end=2020-01-31");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(0);
  });

  it("exports misc sentinel entries with a readable synthetic task title", async () => {
    createTimeEntry({
      id: "misc-entry-1",
      taskId: buildMiscTaskId("2026-04-13"),
      flowDate: "2026-04-13",
      startTime: "2026-04-13T10:00:00Z",
      endTime: "2026-04-13T10:15:00Z",
      durationS: 900,
      source: "timer",
    });

    const res = await callExport("type=entries&format=json&start=2026-04-13&end=2026-04-13");
    expect(res.status).toBe(200);
    const data = await res.json();
    const miscEntry = data.find((entry: { taskId: string }) =>
      entry.taskId === buildMiscTaskId("2026-04-13")
    );

    expect(miscEntry).toMatchObject({
      taskTitle: "Misc time · 2026-04-13",
      project: "Misc",
      durationMins: 15,
    });
  });
});
