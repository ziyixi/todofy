import { describe, it, expect, beforeEach } from "vitest";
import { createTimeEntry, getEntriesByTask } from "@/lib/db/queries/entries";

/**
 * Integration tests for entry API routes.
 * Tests the full pipeline: route handler → DB queries → response.
 */

async function callEntries(method: string, params?: string, body?: unknown) {
  const mod = await import("@/app/api/entries/route");
  const url = `http://localhost:3000/api/entries${params ? `?${params}` : ""}`;
  const request = new Request(url, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  });

  if (method === "GET") return mod.GET(request);
  return mod.POST(request);
}

async function callEntryById(method: string, id: string, body?: unknown) {
  const mod = await import("@/app/api/entries/[id]/route");
  const url = `http://localhost:3000/api/entries/${id}`;
  const request = new Request(url, {
    method,
    ...(body ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
  });

  const params = Promise.resolve({ id });
  if (method === "PUT") return mod.PUT(request, { params });
  return mod.DELETE(request, { params });
}

describe("POST /api/entries", () => {
  it("creates an entry and returns 201", async () => {
    const res = await callEntries("POST", undefined, {
      taskId: "t1",
      flowDate: "2026-04-13",
      startTime: "2026-04-13T09:00:00Z",
      endTime: "2026-04-13T09:30:00Z",
      durationS: 1800,
      source: "manual",
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.taskId).toBe("t1");
    expect(data.id).toBeDefined();

    // Verify in DB
    const entries = getEntriesByTask("t1");
    expect(entries).toHaveLength(1);
  });

  it("returns 400 for missing required fields", async () => {
    const res = await callEntries("POST", undefined, {
      taskId: "t1",
      // missing flowDate and startTime
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/entries", () => {
  beforeEach(() => {
    createTimeEntry({
      id: "e1",
      taskId: "t1",
      flowDate: "2026-04-13",
      startTime: "2026-04-13T09:00:00Z",
      endTime: "2026-04-13T09:30:00Z",
      durationS: 1800,
      source: "timer",
    });
    createTimeEntry({
      id: "e2",
      taskId: "t2",
      flowDate: "2026-04-13",
      startTime: "2026-04-13T10:00:00Z",
      endTime: "2026-04-13T10:15:00Z",
      durationS: 900,
      source: "manual",
    });
  });

  it("retrieves by taskId", async () => {
    const res = await callEntries("GET", "taskId=t1");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].taskId).toBe("t1");
  });

  it("retrieves by date", async () => {
    const res = await callEntries("GET", "date=2026-04-13");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(2);
  });

  it("retrieves by taskId and date together", async () => {
    const res = await callEntries("GET", "taskId=t1&date=2026-04-13");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("e1");
  });

  it("returns 400 with no params", async () => {
    const res = await callEntries("GET");
    expect(res.status).toBe(400);
  });
});

describe("PUT /api/entries/:id", () => {
  beforeEach(() => {
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

  it("updates an entry", async () => {
    const res = await callEntryById("PUT", "e1", {
      startTime: "2026-04-13T10:00:00Z",
      endTime: "2026-04-13T11:00:00Z",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.durationS).toBe(3600);
  });

  it("recalculates duration from the provided timestamps", async () => {
    const res = await callEntryById("PUT", "e1", {
      startTime: "2026-04-13T10:07:00Z",
      endTime: "2026-04-13T11:22:00Z",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.durationS).toBe(4500);
  });

  it("returns 404 for non-existent entry", async () => {
    const res = await callEntryById("PUT", "nonexistent", {
      startTime: "2026-04-13T10:00:00Z",
      endTime: "2026-04-13T11:00:00Z",
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 for missing fields", async () => {
    const res = await callEntryById("PUT", "e1", { startTime: "2026-04-13T10:00:00Z" });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/entries/:id", () => {
  beforeEach(() => {
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

  it("deletes an entry", async () => {
    const res = await callEntryById("DELETE", "e1");
    expect(res.status).toBe(200);
    expect(getEntriesByTask("t1")).toHaveLength(0);
  });

  it("returns 404 for non-existent entry", async () => {
    const res = await callEntryById("DELETE", "nonexistent");
    expect(res.status).toBe(404);
  });
});
