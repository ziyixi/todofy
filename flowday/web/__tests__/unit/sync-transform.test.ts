import { afterEach, describe, expect, it, vi } from "vitest";
import { getSetting, setSetting } from "@/lib/db/queries/settings";
import { getAllTasks } from "@/lib/db/queries/tasks";

describe("todoist sync transform", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    vi.unmock("@/lib/todoist/api");
  });

  it("returns an error when no Todoist API key is configured", async () => {
    const { syncTodoistToDb } = await import("@/lib/todoist/sync");
    await expect(syncTodoistToDb()).resolves.toEqual({
      taskCount: 0,
      error: "No Todoist API key configured",
    });
  });

  it("normalizes Todoist tasks, converts durations, and stamps last_sync_at", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:34:56.000Z"));

    setSetting("todoist_api_key", "test-key");
    const fetchTodoistTasks = vi.fn(async () => [
      {
        id: "todoist-1",
        content: "Write spec",
        description: "Needs markdown review",
        project_id: "project-1",
        priority: 4,
        labels: ["writing"],
        due: { date: "2026-04-15T09:30:00", is_recurring: false },
        duration: { amount: 90, unit: "minute" },
        created_at: "2026-04-10T00:00:00.000Z",
        completed_at: null,
        is_completed: false,
      },
      {
        id: "todoist-2",
        content: "Deep work",
        description: "",
        project_id: "project-2",
        priority: 2,
        labels: [],
        due: { date: "2026-04-16", is_recurring: false },
        duration: { amount: 2, unit: "day" },
        created_at: "2026-04-11T00:00:00.000Z",
        completed_at: null,
        is_completed: false,
      },
      {
        id: "todoist-3",
        content: "No duration",
        description: "",
        project_id: "missing-project",
        priority: 1,
        labels: [],
        due: null,
        duration: null,
        created_at: "2026-04-12T00:00:00.000Z",
        completed_at: null,
        is_completed: false,
      },
    ]);
    const fetchTodoistProjects = vi.fn(async () => [
      { id: "project-1", name: "Inbox", color: "orange" },
      { id: "project-2", name: "Research", color: "sky_blue" },
    ]);

    vi.doMock("@/lib/todoist/api", () => ({
      fetchTodoistTasks,
      fetchTodoistProjects,
    }));

    const { syncTodoistToDb } = await import("@/lib/todoist/sync");
    const result = await syncTodoistToDb();

    expect(result).toEqual({ taskCount: 3 });
    expect(fetchTodoistTasks).toHaveBeenCalledWith("test-key");
    expect(fetchTodoistProjects).toHaveBeenCalledWith("test-key");

    const tasks = getAllTasks().sort((a, b) => a.id.localeCompare(b.id));
    expect(tasks).toEqual([
      expect.objectContaining({
        id: "todoist-1",
        title: "Write spec",
        description: "Needs markdown review",
        projectName: "Inbox",
        projectColor: "#ff9933",
        priority: 4,
        labels: ["writing"],
        estimatedMins: 90,
        dueDate: "2026-04-15",
      }),
      expect.objectContaining({
        id: "todoist-2",
        title: "Deep work",
        projectName: "Research",
        projectColor: "#14aaf5",
        estimatedMins: 960,
        dueDate: "2026-04-16",
      }),
      expect.objectContaining({
        id: "todoist-3",
        title: "No duration",
        projectName: null,
        projectColor: null,
        estimatedMins: null,
        dueDate: null,
      }),
    ]);
    expect(getSetting("last_sync_at")).toBe("2026-04-13T12:34:56.000Z");
  });
});
