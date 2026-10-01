import { afterEach, describe, expect, it, vi } from "vitest";
import { syncTodoistToDb } from "@/lib/todoist/sync";
import { setSetting } from "@/lib/db/queries/settings";
import {
  getAllTasks,
  getDeletedTasks,
  softDeleteTask,
  upsertTasks,
} from "@/lib/db/queries/tasks";
import type { Task } from "@/lib/types/task";

/**
 * End-to-end sync flow: mocks the Todoist HTTP API and runs syncTodoistToDb
 * against a fresh per-test SQLite DB. Verifies the orphan-reconciliation
 * behaviour added so that tasks deleted in Todoist disappear from FlowDay.
 */

interface ApiTaskFixture {
  id: string;
  content: string;
  project_id: string;
  due?: { date: string } | null;
}

function mockTodoist(apiTasks: ApiTaskFixture[]) {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("https://api.todoist.com/api/v1/tasks")) {
      const results = apiTasks.map((t) => ({
        id: t.id,
        content: t.content,
        description: "",
        project_id: t.project_id,
        priority: 1,
        labels: [],
        due: t.due ?? null,
        duration: null,
        created_at: "2026-04-01T00:00:00Z",
        completed_at: null,
        is_completed: false,
      }));
      return new Response(
        JSON.stringify({ results, next_cursor: null }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.startsWith("https://api.todoist.com/api/v1/projects")) {
      return new Response(
        JSON.stringify({
          results: [{ id: "p1", name: "Inbox", color: "berry_red" }],
          next_cursor: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error(`Unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
}

function makeStoredTodoistTask(id: string, dueDate: string | null = null): Task {
  return {
    id,
    todoistId: id,
    title: `Task ${id}`,
    description: null,
    projectName: "Inbox",
    projectColor: "#000000",
    priority: 1,
    labels: [],
    estimatedMins: null,
    isCompleted: false,
    completedAt: null,
    dueDate,
    createdAt: "2026-04-01T00:00:00Z",
    deletedAt: null,
  };
}

describe("syncTodoistToDb — orphan reconciliation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hides tasks that no longer appear in the Todoist response", async () => {
    setSetting("todoist_api_key", "test-key");
    upsertTasks([
      makeStoredTodoistTask("td-keep", "2026-04-15"),
      makeStoredTodoistTask("td-overdue-deleted", "2026-04-10"),
    ]);

    // Todoist now only returns the surviving task — the overdue one was deleted there.
    mockTodoist([{ id: "td-keep", content: "Task td-keep", project_id: "p1", due: { date: "2026-04-15" } }]);

    const result = await syncTodoistToDb();
    expect(result.taskCount).toBe(1);

    const active = getAllTasks().map((t) => t.id);
    expect(active).toEqual(["td-keep"]);

    // Sync-deleted rows stay hidden from the trash dialog (the user can manage
    // them in Todoist directly), so getDeletedTasks excludes them.
    expect(getDeletedTasks()).toHaveLength(0);
  });

  it("auto-restores a previously sync-deleted task if Todoist returns it again", async () => {
    setSetting("todoist_api_key", "test-key");
    upsertTasks([makeStoredTodoistTask("td-1", "2026-04-15")]);

    // Pass 1: Todoist drops the task → sync-delete.
    mockTodoist([]);
    await syncTodoistToDb();
    expect(getAllTasks()).toHaveLength(0);
    expect(getDeletedTasks()).toHaveLength(0); // sync-deletes hidden from trash UI

    // Pass 2: task reappears in Todoist (e.g. user un-completed) → restore.
    mockTodoist([{ id: "td-1", content: "Task td-1", project_id: "p1", due: { date: "2026-04-15" } }]);
    await syncTodoistToDb();
    expect(getAllTasks().map((t) => t.id)).toEqual(["td-1"]);
    expect(getDeletedTasks()).toHaveLength(0);
  });

  it("does NOT restore a task the user soft-deleted in FlowDay even if Todoist returns it", async () => {
    setSetting("todoist_api_key", "test-key");
    upsertTasks([makeStoredTodoistTask("td-1", "2026-04-15")]);
    softDeleteTask("td-1"); // user-initiated trash

    mockTodoist([{ id: "td-1", content: "Task td-1", project_id: "p1", due: { date: "2026-04-15" } }]);
    await syncTodoistToDb();

    expect(getAllTasks()).toHaveLength(0);
    expect(getDeletedTasks().map((t) => t.id)).toEqual(["td-1"]);
  });

  it("leaves local-only tasks (no todoistId) untouched on orphan sweep", async () => {
    setSetting("todoist_api_key", "test-key");
    upsertTasks([
      makeStoredTodoistTask("td-1", "2026-04-15"),
      { ...makeStoredTodoistTask("local-1", "2026-04-15"), todoistId: null },
    ]);

    mockTodoist([]); // Todoist returns nothing
    await syncTodoistToDb();

    const active = getAllTasks().map((t) => t.id);
    expect(active).toEqual(["local-1"]);
  });
});
