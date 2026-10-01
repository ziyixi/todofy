import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFlowStore } from "@/features/flow/store";
import { useTodoistStore } from "@/features/todoist/store";
import { useTimerStore } from "@/features/timer/store";
import type { Task } from "@/lib/types/task";

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferredResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? "task-1",
    todoistId: overrides.todoistId ?? "todoist-1",
    title: overrides.title ?? "Task 1",
    description: overrides.description ?? null,
    projectName: overrides.projectName ?? "Inbox",
    projectColor: overrides.projectColor ?? "#14aaf5",
    priority: overrides.priority ?? 1,
    labels: overrides.labels ?? [],
    estimatedMins: overrides.estimatedMins ?? 30,
    isCompleted: overrides.isCompleted ?? false,
    completedAt: overrides.completedAt ?? null,
    dueDate: overrides.dueDate ?? "2026-04-13",
    createdAt: overrides.createdAt ?? "2026-04-10T00:00:00.000Z",
    deletedAt: overrides.deletedAt ?? null,
  };
}

const originalTimerStopWithoutSaving = useTimerStore.getState().stopWithoutSaving;

function resetFlowStore() {
  useFlowStore.setState({
    currentDate: "2026-04-13",
    viewMode: 1,
    flows: {},
    completedTasks: {},
    sortableGen: 0,
    sortableKeys: {},
    quickFocusTaskIds: {},
    dayCapacityMins: 360,
    hydrated: false,
    planningCompletedDates: {},
  });
}

function resetTodoistStore() {
  useTodoistStore.setState({
    tasks: [],
    isLoading: false,
    isSyncing: false,
    lastSyncAt: null,
    searchQuery: "",
  });
}

function resetTimerStore() {
  useTimerStore.setState({
    activeTaskId: null,
    activeFlowDate: null,
    status: "idle",
    timerMode: "countup",
    pomodoroTargetSeconds: null,
    segmentWallStart: null,
    segmentStartedAt: null,
    sessionSavedSeconds: 0,
    priorSeconds: 0,
    displaySeconds: 0,
    entryRevision: 0,
    pomodoroFinishedTaskId: null,
    pomodoroFinishedFlowDate: null,
    pomodoroFinishedTargetSeconds: null,
    stopWithoutSaving: originalTimerStopWithoutSaving,
  });
}

describe("todoist store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T09:00:00.000Z"));
    resetFlowStore();
    resetTodoistStore();
    resetTimerStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetFlowStore();
    resetTodoistStore();
    resetTimerStore();
  });

  it("sync toggles syncing state, refreshes tasks, and preserves lastSyncAt", async () => {
    const syncRequest = deferredResponse();
    const syncedAt = "2026-04-13T09:30:00.000Z";
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";

      if (url === "/api/sync" && method === "POST") {
        return syncRequest.promise;
      }

      if (url === "/api/tasks" && method === "GET") {
        return Promise.resolve(jsonResponse([makeTask()]));
      }

      if (url === "/api/settings" && method === "GET") {
        return Promise.resolve(jsonResponse({ last_sync_at: syncedAt }));
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const syncPromise = useTodoistStore.getState().sync();
    expect(useTodoistStore.getState().isSyncing).toBe(true);

    syncRequest.resolve(jsonResponse({ taskCount: 1, lastSyncAt: syncedAt }));
    await syncPromise;

    const state = useTodoistStore.getState();
    expect(state.isSyncing).toBe(false);
    expect(state.lastSyncAt).toBe(syncedAt);
    expect(state.tasks.map((task) => task.id)).toEqual(["task-1"]);
  });

  it("short-circuits duplicate sync requests while one is already running", async () => {
    const syncRequest = deferredResponse();
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";

      if (url === "/api/sync" && method === "POST") {
        return syncRequest.promise;
      }

      if (url === "/api/tasks" && method === "GET") {
        return Promise.resolve(jsonResponse([]));
      }

      if (url === "/api/settings" && method === "GET") {
        return Promise.resolve(jsonResponse({ last_sync_at: null }));
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const firstSync = useTodoistStore.getState().sync();
    const secondSync = useTodoistStore.getState().sync();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    syncRequest.resolve(jsonResponse({ taskCount: 0, lastSyncAt: null }));
    await Promise.all([firstSync, secondSync]);

    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) =>
          (typeof input === "string" ? input : input.toString()) === "/api/sync" &&
          (init?.method ?? "GET") === "POST"
      )
    ).toHaveLength(1);
  });

  it("deletes tasks optimistically, removes them from flow state, and stops the active timer", async () => {
    const stopWithoutSaving = vi.fn();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";

      if (url === "/api/tasks" && method === "DELETE") {
        return jsonResponse({ success: true });
      }

      if (url === "/api/flows" && method === "PUT") {
        return jsonResponse({ success: true });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    useTodoistStore.setState({ tasks: [makeTask()] });
    useFlowStore.setState({
      flows: { "2026-04-13": ["task-1"] },
      completedTasks: { "2026-04-13": ["task-1"] },
    });
    useTimerStore.setState({
      activeTaskId: "task-1",
      stopWithoutSaving,
    });

    await useTodoistStore.getState().deleteTask("task-1");

    expect(useTodoistStore.getState().tasks).toEqual([]);
    expect(useFlowStore.getState().flows["2026-04-13"]).toEqual([]);
    expect(useFlowStore.getState().completedTasks["2026-04-13"]).toEqual([]);
    expect(stopWithoutSaving).toHaveBeenCalledTimes(1);
  });

  it("rehydrates tasks and flows if optimistic delete persistence fails", async () => {
    const restoredTask = makeTask();
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method ?? "GET";

      if (url === "/api/tasks" && method === "DELETE") {
        return new Response(null, { status: 500 });
      }

      if (url === "/api/tasks" && method === "GET") {
        return jsonResponse([restoredTask]);
      }

      if (url === "/api/settings" && method === "GET") {
        return jsonResponse({ last_sync_at: "2026-04-13T10:00:00.000Z" });
      }

      if (url === "/api/flows" && method === "PUT") {
        return jsonResponse({ success: true });
      }

      if (url === "/api/flows" && method === "GET") {
        return jsonResponse({
          flows: { "2026-04-13": ["task-1"] },
          completedTasks: {},
        });
      }

      if (url.startsWith("/api/settings?today=") && method === "GET") {
        return jsonResponse({
          day_capacity_mins: 360,
          planning_completed_today: false,
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    useTodoistStore.setState({ tasks: [restoredTask] });
    useFlowStore.setState({
      flows: { "2026-04-13": ["task-1"] },
      completedTasks: {},
    });

    await useTodoistStore.getState().deleteTask("task-1");

    expect(useTodoistStore.getState().tasks.map((task) => task.id)).toEqual(["task-1"]);
    expect(useTodoistStore.getState().lastSyncAt).toBe("2026-04-13T10:00:00.000Z");
    expect(useFlowStore.getState().flows["2026-04-13"]).toEqual(["task-1"]);
  });
});
