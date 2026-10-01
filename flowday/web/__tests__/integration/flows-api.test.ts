import { describe, it, expect } from "vitest";
import { addCompletedFlowTask, getAllFlows, setFlowTaskIds } from "@/lib/db/queries/flows";
import { upsertTasks } from "@/lib/db/queries/tasks";
import type { Task } from "@/lib/types/task";

/**
 * Integration tests for the flows API routes.
 * Tests the full pipeline: route handler → DB queries → response.
 */

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

async function callFlows(method: "GET" | "PUT", body?: unknown) {
  const mod = await import("@/app/api/flows/route");
  const url = "http://localhost:3000/api/flows";
  const request = new Request(url, {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });

  if (method === "GET") return mod.GET();
  return mod.PUT(request);
}

describe("GET /api/flows", () => {
  it("returns empty when no data", async () => {
    const res = await callFlows("GET");
    const data = await res.json();
    expect(data.flows).toEqual({});
    expect(data.completedTasks).toEqual({});
  });

  it("returns seeded flows and completed tasks", async () => {
    upsertTasks([
      makeTask({ id: "t1", title: "Task A" }),
      makeTask({ id: "t2", title: "Task B" }),
    ]);
    setFlowTaskIds("2026-04-13", ["t1", "t2"]);
    addCompletedFlowTask("2026-04-13", "t1");

    const res = await callFlows("GET");
    const data = await res.json();
    expect(data.flows["2026-04-13"]).toEqual(["t1", "t2"]);
    expect(data.completedTasks["2026-04-13"]).toEqual(["t1"]);
  });
});

describe("PUT /api/flows — setFlow", () => {
  it("sets task IDs and verify via GET", async () => {
    upsertTasks([
      makeTask({ id: "t1" }),
      makeTask({ id: "t2" }),
    ]);

    const putRes = await callFlows("PUT", {
      action: "setFlow",
      date: "2026-04-13",
      taskIds: ["t1", "t2"],
    });
    expect(putRes.status).toBe(200);
    const putData = await putRes.json();
    expect(putData.success).toBe(true);

    const getRes = await callFlows("GET");
    const getData = await getRes.json();
    expect(getData.flows["2026-04-13"]).toEqual(["t1", "t2"]);
  });

  it("returns 400 if taskIds is not an array", async () => {
    const res = await callFlows("PUT", {
      action: "setFlow",
      date: "2026-04-13",
      taskIds: "not-an-array",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("clears a flow when given an empty array", async () => {
    upsertTasks([makeTask({ id: "t1" })]);
    setFlowTaskIds("2026-04-13", ["t1"]);

    const res = await callFlows("PUT", {
      action: "setFlow",
      date: "2026-04-13",
      taskIds: [],
    });
    expect(res.status).toBe(200);

    const flows = getAllFlows();
    expect(flows["2026-04-13"]).toBeUndefined();
  });
});

describe("PUT /api/flows — addCompleted", () => {
  it("adds task to completed", async () => {
    upsertTasks([makeTask({ id: "t1" })]);
    setFlowTaskIds("2026-04-13", ["t1"]);

    const res = await callFlows("PUT", {
      action: "addCompleted",
      date: "2026-04-13",
      taskId: "t1",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    const getRes = await callFlows("GET");
    const getData = await getRes.json();
    expect(getData.completedTasks["2026-04-13"]).toContain("t1");
  });

  it("returns 400 if taskId is missing", async () => {
    const res = await callFlows("PUT", {
      action: "addCompleted",
      date: "2026-04-13",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });
});

describe("PUT /api/flows — removeCompleted", () => {
  it("removes task from completed", async () => {
    upsertTasks([makeTask({ id: "t1" })]);
    setFlowTaskIds("2026-04-13", ["t1"]);
    addCompletedFlowTask("2026-04-13", "t1");

    const res = await callFlows("PUT", {
      action: "removeCompleted",
      date: "2026-04-13",
      taskId: "t1",
    });
    expect(res.status).toBe(200);

    const getRes = await callFlows("GET");
    const getData = await getRes.json();
    const completed = getData.completedTasks["2026-04-13"] ?? [];
    expect(completed).not.toContain("t1");
  });
});

describe("PUT /api/flows — rollover", () => {
  it("moves incomplete tasks from source to target", async () => {
    upsertTasks([
      makeTask({ id: "t1", title: "Done Task" }),
      makeTask({ id: "t2", title: "Incomplete Task" }),
    ]);
    setFlowTaskIds("2026-04-13", ["t1", "t2"]);
    addCompletedFlowTask("2026-04-13", "t1");

    const res = await callFlows("PUT", {
      action: "rollover",
      date: "2026-04-13",
      fromDate: "2026-04-13",
      toDate: "2026-04-14",
    });
    expect(res.status).toBe(200);

    const flows = getAllFlows();
    // t2 was incomplete, should be in target
    expect(flows["2026-04-14"]).toContain("t2");
    // t2 should be removed from source
    expect(flows["2026-04-13"]).not.toContain("t2");
    // t1 was completed, should remain in source
    expect(flows["2026-04-13"]).toContain("t1");
  });

  it("deduplicates tasks that already exist on the target date", async () => {
    upsertTasks([
      makeTask({ id: "t1", title: "Done Task" }),
      makeTask({ id: "t2", title: "Carry once" }),
    ]);
    setFlowTaskIds("2026-04-13", ["t1", "t2"]);
    setFlowTaskIds("2026-04-14", ["t2"]);
    addCompletedFlowTask("2026-04-13", "t1");

    const res = await callFlows("PUT", {
      action: "rollover",
      date: "2026-04-13",
      fromDate: "2026-04-13",
      toDate: "2026-04-14",
    });
    expect(res.status).toBe(200);

    const flows = getAllFlows();
    expect(flows["2026-04-14"]).toEqual(["t2"]);
  });

  it("is a no-op when there are no incomplete tasks to move", async () => {
    upsertTasks([makeTask({ id: "t1", title: "Done Task" })]);
    setFlowTaskIds("2026-04-13", ["t1"]);
    addCompletedFlowTask("2026-04-13", "t1");

    const res = await callFlows("PUT", {
      action: "rollover",
      date: "2026-04-13",
      fromDate: "2026-04-13",
      toDate: "2026-04-14",
    });
    expect(res.status).toBe(200);

    const flows = getAllFlows();
    expect(flows["2026-04-13"]).toEqual(["t1"]);
    expect(flows["2026-04-14"]).toBeUndefined();
  });
});

describe("PUT /api/flows — rolloverSelected", () => {
  it("moves only selected tasks", async () => {
    upsertTasks([
      makeTask({ id: "t1", title: "Task A" }),
      makeTask({ id: "t2", title: "Task B" }),
      makeTask({ id: "t3", title: "Task C" }),
    ]);
    setFlowTaskIds("2026-04-13", ["t1", "t2", "t3"]);

    const res = await callFlows("PUT", {
      action: "rolloverSelected",
      date: "2026-04-13",
      fromDate: "2026-04-13",
      toDate: "2026-04-14",
      taskIds: ["t1", "t3"],
    });
    expect(res.status).toBe(200);

    const flows = getAllFlows();
    // t1 and t3 should move to target
    expect(flows["2026-04-14"]).toContain("t1");
    expect(flows["2026-04-14"]).toContain("t3");
    // t2 should remain in source
    expect(flows["2026-04-13"]).toContain("t2");
    // t1 and t3 should be gone from source
    expect(flows["2026-04-13"]).not.toContain("t1");
    expect(flows["2026-04-13"]).not.toContain("t3");
  });

  it("is a no-op when none of the selected task IDs are in the source flow", async () => {
    upsertTasks([makeTask({ id: "t1", title: "Task A" })]);
    setFlowTaskIds("2026-04-13", ["t1"]);

    const res = await callFlows("PUT", {
      action: "rolloverSelected",
      date: "2026-04-13",
      fromDate: "2026-04-13",
      toDate: "2026-04-14",
      taskIds: ["missing-task"],
    });
    expect(res.status).toBe(200);

    const flows = getAllFlows();
    expect(flows["2026-04-13"]).toEqual(["t1"]);
    expect(flows["2026-04-14"]).toBeUndefined();
  });
});

describe("PUT /api/flows — errors", () => {
  it("returns 400 for unknown action", async () => {
    const res = await callFlows("PUT", {
      action: "invalidAction",
      date: "2026-04-13",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("returns 400 when date is missing", async () => {
    const res = await callFlows("PUT", {
      action: "setFlow",
      taskIds: ["t1"],
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("returns the same date-required error when the payload is not an object", async () => {
    const res = await callFlows("PUT", "not-an-object");
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("date is required");
  });

  it("returns 400 when rolloverSelected is missing required fields", async () => {
    const res = await callFlows("PUT", {
      action: "rolloverSelected",
      date: "2026-04-13",
      fromDate: "2026-04-13",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("fromDate, toDate, and taskIds required");
  });
});
