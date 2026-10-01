import { describe, it, expect, beforeEach } from "vitest";
import { softDeleteTask, upsertTasks } from "@/lib/db/queries/tasks";
import type { Task } from "@/lib/types/task";

/**
 * Integration tests for the tasks/deleted API routes.
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

async function callDeletedTasks(method: "GET" | "POST", body?: unknown) {
  const mod = await import("@/app/api/tasks/deleted/route");
  const url = "http://localhost:3000/api/tasks/deleted";
  const request = new Request(url, {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });

  if (method === "GET") return mod.GET();
  return mod.POST(request);
}

async function callTasks() {
  const mod = await import("@/app/api/tasks/route");
  return mod.GET();
}

describe("GET /api/tasks/deleted", () => {
  it("returns only soft-deleted tasks", async () => {
    upsertTasks([
      makeTask({ id: "t1", title: "Active Task" }),
      makeTask({ id: "t2", title: "Will Be Deleted" }),
      makeTask({ id: "t3", title: "Also Deleted" }),
    ]);
    softDeleteTask("t2");
    softDeleteTask("t3");

    const res = await callDeletedTasks("GET");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(2);
    const ids = data.map((t: { id: string }) => t.id).sort();
    expect(ids).toEqual(["t2", "t3"]);
  });
});

describe("POST /api/tasks/deleted (restore)", () => {
  beforeEach(() => {
    upsertTasks([
      makeTask({ id: "t1", title: "Active Task" }),
      makeTask({ id: "t2", title: "Deleted Task" }),
    ]);
    softDeleteTask("t2");
  });

  it("restores a soft-deleted task", async () => {
    const res = await callDeletedTasks("POST", { taskId: "t2" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    // Verify it disappears from deleted list
    const deletedRes = await callDeletedTasks("GET");
    const deletedData = await deletedRes.json();
    const deletedIds = deletedData.map((t: { id: string }) => t.id);
    expect(deletedIds).not.toContain("t2");

    // Verify it reappears in the active tasks list
    const activeRes = await callTasks();
    const activeData = await activeRes.json();
    const activeIds = activeData.map((t: { id: string }) => t.id);
    expect(activeIds).toContain("t2");
  });

  it("returns 400 for missing taskId", async () => {
    const res = await callDeletedTasks("POST", { notTaskId: "t2" });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });
});
