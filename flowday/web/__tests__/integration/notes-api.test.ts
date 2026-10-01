import { describe, it, expect } from "vitest";

/**
 * Integration tests for the notes API routes.
 * Tests the full pipeline: route handler → DB queries → response.
 */

async function callNotes(method: "GET" | "PUT", params?: string, body?: unknown) {
  const mod = await import("@/app/api/notes/route");
  const url = `http://localhost:3000/api/notes${params ? `?${params}` : ""}`;
  const request = new Request(url, {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });

  if (method === "GET") return mod.GET(request);
  return mod.PUT(request);
}

describe("GET /api/notes", () => {
  it("returns empty default for non-existent note when taskId+date provided", async () => {
    const res = await callNotes("GET", "taskId=t1&date=2026-04-13");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.taskId).toBe("t1");
    expect(data.flowDate).toBe("2026-04-13");
    expect(data.content).toBe("");
  });

  it("returns 400 without params", async () => {
    const res = await callNotes("GET");
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });
});

describe("PUT /api/notes", () => {
  it("creates a note, GET returns it", async () => {
    const putRes = await callNotes("PUT", undefined, {
      taskId: "t1",
      flowDate: "2026-04-13",
      content: "My first note",
    });
    expect(putRes.status).toBe(200);
    const putData = await putRes.json();
    expect(putData.taskId).toBe("t1");
    expect(putData.flowDate).toBe("2026-04-13");
    expect(putData.content).toBe("My first note");

    // Verify via GET
    const getRes = await callNotes("GET", "taskId=t1&date=2026-04-13");
    const getData = await getRes.json();
    expect(getData.content).toBe("My first note");
  });

  it("updates existing note (upsert)", async () => {
    // Create initial note
    await callNotes("PUT", undefined, {
      taskId: "t1",
      flowDate: "2026-04-13",
      content: "Original content",
    });

    // Update the note
    const putRes = await callNotes("PUT", undefined, {
      taskId: "t1",
      flowDate: "2026-04-13",
      content: "Updated content",
    });
    expect(putRes.status).toBe(200);
    const putData = await putRes.json();
    expect(putData.content).toBe("Updated content");

    // Verify via GET
    const getRes = await callNotes("GET", "taskId=t1&date=2026-04-13");
    const getData = await getRes.json();
    expect(getData.content).toBe("Updated content");
  });

  it("returns 400 with missing fields", async () => {
    const res = await callNotes("PUT", undefined, {
      taskId: "t1",
      // missing flowDate and content
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });
});

describe("GET /api/notes — by date", () => {
  it("returns all notes for a given date", async () => {
    // Create multiple notes for the same date
    await callNotes("PUT", undefined, {
      taskId: "t1",
      flowDate: "2026-04-13",
      content: "Note for task 1",
    });
    await callNotes("PUT", undefined, {
      taskId: "t2",
      flowDate: "2026-04-13",
      content: "Note for task 2",
    });
    // Create a note for a different date (should not appear)
    await callNotes("PUT", undefined, {
      taskId: "t3",
      flowDate: "2026-04-14",
      content: "Note for different date",
    });

    const res = await callNotes("GET", "date=2026-04-13");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(2);
    const taskIds = data.map((n: { taskId: string }) => n.taskId).sort();
    expect(taskIds).toEqual(["t1", "t2"]);
  });
});
