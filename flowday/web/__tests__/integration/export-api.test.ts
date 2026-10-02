import { describe, it, expect, beforeEach, vi } from "vitest";
import { exportData, exportRequestError } from "@/features/settings/services/export-service";
import { queryAnalytics } from "@/lib/client/flowday-api";
import type { Task } from "@/lib/types/task";
import { addCompletedFlowTask, createTimeEntry, fakeFetch, setFlowTaskIds, upsertTasks } from "../helpers/fake-worker";
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

// The client path of the Export dialog: validate, fetch the range's rows, build the file in the browser. The file
// is wrapped in a Response so the assertions read like the container era's /api/export tests.
async function callExport(params: string) {
  vi.stubGlobal("fetch", fakeFetch);
  const query = new URLSearchParams(params);
  const args = { type: query.get("type"), format: query.get("format"), startDate: query.get("start"), endDate: query.get("end") };
  if (exportRequestError(args) !== null) return new Response(null, { status: 400 });
  const dataset = await queryAnalytics({ start: args.startDate ?? "", end: args.endDate ?? "" });
  const result = exportData(args, dataset);
  if (!result.ok) return new Response(null, { status: 400 });
  return new Response(result.file.body, {
    headers: {
      "Content-Type": result.file.contentType,
      "Content-Disposition": `attachment; filename="${result.file.filename}"`,
    },
  });
}

describe("export (built in the browser)", () => {
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
