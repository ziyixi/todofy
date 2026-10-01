import { describe, it, expect, beforeEach } from "vitest";
import { getAllFlows, setFlowTaskIds } from "@/lib/db/queries/flows";
import { upsertTasks } from "@/lib/db/queries/tasks";
import type { Task } from "@/lib/types/task";

/**
 * Integration tests for the tasks API routes.
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

async function callTasks(method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown) {
  const mod = await import("@/app/api/tasks/route");
  const url = "http://localhost:3000/api/tasks";
  const request = new Request(url, {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });

  if (method === "GET") return mod.GET();
  if (method === "POST") return mod.POST(request);
  if (method === "PATCH") return mod.PATCH(request);
  return mod.DELETE(request);
}

describe("GET /api/tasks", () => {
  it("returns non-deleted tasks", async () => {
    upsertTasks([
      makeTask({ id: "t1", title: "Active Task" }),
      makeTask({ id: "t2", title: "Another Task" }),
    ]);

    const res = await callTasks("GET");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(data.map((t: { id: string }) => t.id).sort()).toEqual(["t1", "t2"]);
  });
});

describe("PATCH /api/tasks", () => {
  beforeEach(() => {
    upsertTasks([makeTask({ id: "t1", estimatedMins: 30 })]);
  });

  it("updates estimate", async () => {
    const res = await callTasks("PATCH", {
      taskId: "t1",
      estimatedMins: 60,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    // Verify via GET
    const getRes = await callTasks("GET");
    const tasks = await getRes.json();
    const task = tasks.find((t: { id: string }) => t.id === "t1");
    expect(task.estimatedMins).toBe(60);
  });

  it("accepts null to clear estimate", async () => {
    const res = await callTasks("PATCH", {
      taskId: "t1",
      estimatedMins: null,
    });
    expect(res.status).toBe(200);

    const getRes = await callTasks("GET");
    const tasks = await getRes.json();
    const task = tasks.find((t: { id: string }) => t.id === "t1");
    expect(task.estimatedMins).toBeNull();
  });

  it("returns 400 for missing taskId", async () => {
    const res = await callTasks("PATCH", {
      estimatedMins: 60,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("returns 400 for negative estimatedMins", async () => {
    const res = await callTasks("PATCH", {
      taskId: "t1",
      estimatedMins: -10,
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("updates title for local task", async () => {
    const res = await callTasks("PATCH", {
      taskId: "t1",
      title: "Renamed Task",
    });
    expect(res.status).toBe(200);

    const getRes = await callTasks("GET");
    const tasks = await getRes.json();
    const task = tasks.find((t: { id: string }) => t.id === "t1");
    expect(task.title).toBe("Renamed Task");
  });

  it("trims title updates and accepts stringified numeric estimates", async () => {
    const res = await callTasks("PATCH", {
      taskId: "t1",
      title: "  Renamed Task  ",
      estimatedMins: "75",
    });
    expect(res.status).toBe(200);

    const getRes = await callTasks("GET");
    const tasks = await getRes.json();
    const task = tasks.find((t: { id: string }) => t.id === "t1");
    expect(task.title).toBe("Renamed Task");
    expect(task.estimatedMins).toBe(75);
  });

  it("returns 400 for empty title", async () => {
    const res = await callTasks("PATCH", {
      taskId: "t1",
      title: "",
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/tasks", () => {
  beforeEach(() => {
    upsertTasks([
      makeTask({ id: "t1", title: "Task to delete" }),
      makeTask({ id: "t2", title: "Task to keep" }),
    ]);
  });

  it("soft-deletes a task (verify task gone from GET)", async () => {
    const res = await callTasks("DELETE", { taskId: "t1" });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);

    // Verify t1 no longer appears in GET
    const getRes = await callTasks("GET");
    const tasks = await getRes.json();
    const ids = tasks.map((t: { id: string }) => t.id);
    expect(ids).not.toContain("t1");
    expect(ids).toContain("t2");
  });

  it("removes task from flows", async () => {
    setFlowTaskIds("2026-04-13", ["t1", "t2"]);

    await callTasks("DELETE", { taskId: "t1" });

    const flows = getAllFlows();
    expect(flows["2026-04-13"]).not.toContain("t1");
    expect(flows["2026-04-13"]).toContain("t2");
  });

  it("returns 400 for missing taskId", async () => {
    const res = await callTasks("DELETE", { notTaskId: "t1" });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });
});

describe("POST /api/tasks (quick add)", () => {
  it("creates a local task and returns 201", async () => {
    const res = await callTasks("POST", { title: "My local task" });
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.id).toMatch(/^local-/);
    expect(task.title).toBe("My local task");
    expect(task.todoistId).toBeNull();
  });

  it("returns 400 for empty title", async () => {
    const res = await callTasks("POST", { title: "" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing title", async () => {
    const res = await callTasks("POST", {});
    expect(res.status).toBe(400);
  });

  it("created task appears in GET /api/tasks", async () => {
    await callTasks("POST", { title: "Visible task" });
    const res = await callTasks("GET");
    const tasks = await res.json();
    expect(tasks.some((t: { title: string }) => t.title === "Visible task")).toBe(true);
  });

  it("trims the title and preserves optional fields", async () => {
    const res = await callTasks("POST", {
      title: "  Planned task  ",
      priority: 3,
      dueDate: "2026-04-20",
      estimatedMins: 45,
      labels: ["docs", "review"],
      description: "Needs commas, quotes, and detail",
    });
    expect(res.status).toBe(201);
    const task = await res.json();
    expect(task.title).toBe("Planned task");
    expect(task.priority).toBe(3);
    expect(task.dueDate).toBe("2026-04-20");
    expect(task.estimatedMins).toBe(45);
    expect(task.labels).toEqual(["docs", "review"]);
    expect(task.description).toBe("Needs commas, quotes, and detail");
  });
});
