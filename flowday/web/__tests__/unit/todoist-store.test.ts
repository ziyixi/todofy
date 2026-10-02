import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFlowStore } from "@/features/flow/store";
import { useTodoistStore } from "@/features/todoist/store";
import { MAX_SYNC_REQUESTS } from "@/features/todoist/store/todoist-store";
import { useTimerStore } from "@/features/timer/store";
import { SyncTasksResponse_State } from "@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb";
import type { Task } from "@/lib/types/task";
import { fakeFetch, fakeWorker, setFlowTaskIds, setSetting, upsertTasks } from "../helpers/fake-worker";

const SYNC = "POST /api/v1/tasks:sync";

/** The fake Worker's fetch, with SyncTasks held until `release` (to observe the store while a sync runs). */
function heldSync() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = `${init?.method ?? "GET"} ${String(input)}`;
    calls.push(call);
    if (call === SYNC) await gate;
    return fakeFetch(input, init);
  });
  return { fetch, calls, release };
}

/** The `METHOD path` of every request the fake Worker received. */
function requests(): string[] {
  return fakeWorker.requests.map((request) => `${request.method} ${request.path}`);
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
    upsertTasks([makeTask()]);
    fakeWorker.syncAnswers = [{ state: SyncTasksResponse_State.SYNCED, changed: 1, fullSync: false }];
    const held = heldSync();
    vi.stubGlobal("fetch", held.fetch);

    const syncPromise = useTodoistStore.getState().sync();
    expect(useTodoistStore.getState().isSyncing).toBe(true);

    held.release();
    await syncPromise;

    const state = useTodoistStore.getState();
    expect(state.isSyncing).toBe(false);
    expect(state.lastSyncAt).toBe("2026-04-13T09:00:00.000Z");
    expect(state.tasks.map((task) => task.id)).toEqual(["task-1"]);
  });

  it("short-circuits duplicate sync requests while one is already running", async () => {
    const held = heldSync();
    vi.stubGlobal("fetch", held.fetch);

    const firstSync = useTodoistStore.getState().sync();
    const secondSync = useTodoistStore.getState().sync();

    expect(held.calls).toEqual([SYNC]);

    held.release();
    await Promise.all([firstSync, secondSync]);

    expect(held.calls.filter((call) => call === SYNC)).toHaveLength(1);
  });

  it("an automatic sync with nothing new does not reload the task list", async () => {
    useTodoistStore.setState({ lastSyncAt: "2026-04-13T09:00:00.000Z" });
    fakeWorker.syncAnswers = [{ state: SyncTasksResponse_State.THROTTLED, changed: 0, fullSync: false }];
    vi.stubGlobal("fetch", fakeFetch);
    expect(await useTodoistStore.getState().sync("auto")).toBe(true);
    expect(requests()).toEqual([SYNC]);
    expect(fakeWorker.requests[0]?.body).toEqual({ mode: "auto" });
  });

  it("asks again right away while the Worker answers partial, then reloads the task list once", async () => {
    upsertTasks([makeTask()]);
    fakeWorker.syncAnswers = [
      { state: SyncTasksResponse_State.PARTIAL, changed: 200, fullSync: true },
      { state: SyncTasksResponse_State.PARTIAL, changed: 200, fullSync: true },
      { state: SyncTasksResponse_State.SYNCED, changed: 200, fullSync: true },
    ];
    vi.stubGlobal("fetch", fakeFetch);
    expect(await useTodoistStore.getState().sync("auto")).toBe(true);
    expect(requests().filter((call) => call === SYNC)).toHaveLength(3);
    expect(requests().filter((call) => call === "GET /api/v1/tasks")).toHaveLength(1);
    expect(useTodoistStore.getState().tasks.map((task) => task.id)).toEqual(["task-1"]);
  });

  it("stops after MAX_SYNC_REQUESTS partial answers", async () => {
    fakeWorker.syncAnswers = Array.from({ length: MAX_SYNC_REQUESTS + 5 }, () => ({ state: SyncTasksResponse_State.PARTIAL, changed: 0, fullSync: false }));
    vi.stubGlobal("fetch", fakeFetch);
    expect(await useTodoistStore.getState().sync("auto")).toBe(true);
    expect(requests().filter((call) => call === SYNC)).toHaveLength(MAX_SYNC_REQUESTS);
  });

  it("deletes tasks optimistically, removes them from flow state, and stops the active timer", async () => {
    const stopWithoutSaving = vi.fn();
    vi.stubGlobal("fetch", fakeFetch);
    upsertTasks([makeTask()]);
    setFlowTaskIds("2026-04-13", ["task-1"]);

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
    expect(requests()).toContain("DELETE /api/v1/tasks/task-1");
    expect(fakeWorker.tasks.get("task-1")?.deletedAt).not.toBeNull();
  });

  it("rehydrates tasks and flows if optimistic delete persistence fails", async () => {
    const restoredTask = makeTask();
    upsertTasks([restoredTask]);
    setFlowTaskIds("2026-04-13", ["task-1"]);
    setSetting("last_sync_at", "2026-04-13T10:00:00.000Z");
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE") return new Response(null, { status: 500 });
      // The flow writes of the optimistic removal fail too, as the delete would have.
      if ((init?.method ?? "GET") === "PATCH") return new Response(null, { status: 500 });
      return fakeFetch(input, init);
    });

    useTodoistStore.setState({ tasks: [restoredTask] });
    useFlowStore.setState({
      flows: { "2026-04-13": ["task-1"] },
      completedTasks: {},
    });

    await useTodoistStore.getState().deleteTask("task-1");

    await vi.waitFor(() => {
      expect(useTodoistStore.getState().tasks.map((task) => task.id)).toEqual(["task-1"]);
      expect(useTodoistStore.getState().lastSyncAt).toBe("2026-04-13T10:00:00.000Z");
      expect(useFlowStore.getState().flows["2026-04-13"]).toEqual(["task-1"]);
    });
  });
});
