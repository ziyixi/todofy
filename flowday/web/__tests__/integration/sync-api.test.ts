import { afterEach, describe, expect, it, vi } from "vitest";
import { getSetting, setSetting } from "@/lib/db/queries/settings";

async function callSync() {
  const mod = await import("@/app/api/sync/route");
  return mod.POST();
}

describe("POST /api/sync", () => {
  afterEach(() => {
    vi.resetModules();
    vi.unmock("@/lib/todoist/sync");
  });

  it("returns 400 when no Todoist API key is configured", async () => {
    const res = await callSync();
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toMatch(/No Todoist API key configured/);
  });

  it("returns 400 when syncTodoistToDb reports an application error", async () => {
    setSetting("todoist_api_key", "test-key");
    vi.doMock("@/lib/todoist/sync", () => ({
      syncTodoistToDb: vi.fn(async () => ({
        taskCount: 0,
        error: "Todoist rejected the request",
      })),
    }));

    const res = await callSync();
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe("Todoist rejected the request");
  });

  it("returns 500 when syncTodoistToDb throws", async () => {
    setSetting("todoist_api_key", "test-key");
    vi.doMock("@/lib/todoist/sync", () => ({
      syncTodoistToDb: vi.fn(async () => {
        throw new Error("Network exploded");
      }),
    }));

    const res = await callSync();
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("Network exploded");
  });

  it("returns taskCount and the persisted lastSyncAt on success", async () => {
    setSetting("todoist_api_key", "test-key");
    const syncedAt = "2026-04-13T12:34:56.000Z";
    vi.doMock("@/lib/todoist/sync", () => ({
      syncTodoistToDb: vi.fn(async () => {
        setSetting("last_sync_at", syncedAt);
        return { taskCount: 3 };
      }),
    }));

    const res = await callSync();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      taskCount: 3,
      lastSyncAt: syncedAt,
    });
    expect(getSetting("last_sync_at")).toBe(syncedAt);
  });
});
