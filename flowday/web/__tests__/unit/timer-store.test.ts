import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTimerStore } from "@/features/timer/store";
import { _getChimeCount, _resetChime } from "@/lib/utils/chime";
import { buildMiscTaskId } from "@/lib/utils/misc-task";

interface EntryPostBody {
  taskId: string;
  flowDate: string;
  durationS: number;
  source: string;
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createTimerFetchMock(options: {
  onEntryPost?: (body: EntryPostBody) => void;
  timerSession?: unknown;
} = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";

    if (url === "/api/timer/session") {
      if (method === "GET") {
        return jsonResponse({ session: options.timerSession ?? null });
      }
      if (method === "PUT" || method === "DELETE") {
        return jsonResponse({ success: true });
      }
    }

    if (url.startsWith("/api/entries?taskId=") && method === "GET") {
      return jsonResponse([]);
    }

    if (url === "/api/entries" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as EntryPostBody;
      options.onEntryPost?.(body);
      return jsonResponse({ id: "x" }, 201);
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });
}

function resetTimerStore() {
  useTimerStore.getState().stopWithoutSaving();
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
  });
}

describe("timer store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T09:00:00.000Z"));
    resetTimerStore();
    _resetChime();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetTimerStore();
    _resetChime();
  });

  it("switches active tasks and saves the previous running segment", async () => {
    const posts: EntryPostBody[] = [];
    const fetchMock = createTimerFetchMock({
      onEntryPost: (body) => posts.push(body),
    });

    vi.stubGlobal("fetch", fetchMock);

    await useTimerStore.getState().startTimer("task-1", "2026-04-13");
    await vi.advanceTimersByTimeAsync(5000);
    await useTimerStore.getState().startTimer("task-2", "2026-04-13");

    const state = useTimerStore.getState();
    expect(state.activeTaskId).toBe("task-2");
    expect(state.status).toBe("running");
    expect(state.timerMode).toBe("countup");

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      taskId: "task-1",
      flowDate: "2026-04-13",
      durationS: 5,
      source: "timer",
    });
  });

  it("auto-stops pomodoro at target, saves time, and clears active timer state", async () => {
    const posts: EntryPostBody[] = [];
    const fetchMock = createTimerFetchMock({
      onEntryPost: (body) => posts.push(body),
    });

    vi.stubGlobal("fetch", fetchMock);

    await useTimerStore.getState().startPomodoro("task-1", "2026-04-13", 3);
    await vi.advanceTimersByTimeAsync(3000);

    const state = useTimerStore.getState();
    expect(state.activeTaskId).toBeNull();
    expect(state.status).toBe("idle");
    expect(state.timerMode).toBe("countup");
    expect(state.displaySeconds).toBe(0);

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      taskId: "task-1",
      flowDate: "2026-04-13",
      durationS: 3,
      source: "timer",
    });
  });

  it("plays a completion chime exactly once when a pomodoro reaches zero", async () => {
    const fetchMock = createTimerFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    expect(_getChimeCount()).toBe(0);

    await useTimerStore.getState().startPomodoro("task-1", "2026-04-13", 2);
    await vi.advanceTimersByTimeAsync(2000);

    expect(_getChimeCount()).toBe(1);

    // Idempotence guard: extra ticks after completion must not double-fire.
    await vi.advanceTimersByTimeAsync(3000);
    expect(_getChimeCount()).toBe(1);
  });

  it("marks the finished-pomodoro slot when the timer hits zero, and clears it on next start", async () => {
    const fetchMock = createTimerFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await useTimerStore.getState().startPomodoro("task-1", "2026-04-21", 4);
    await vi.advanceTimersByTimeAsync(4000);

    let state = useTimerStore.getState();
    // Active timer is gone, but the finished marker captures what just ended so
    // the pop-out can offer restart/complete instead of a bare idle screen.
    expect(state.activeTaskId).toBeNull();
    expect(state.status).toBe("idle");
    expect(state.pomodoroFinishedTaskId).toBe("task-1");
    expect(state.pomodoroFinishedFlowDate).toBe("2026-04-21");
    expect(state.pomodoroFinishedTargetSeconds).toBe(4);

    // Starting a new count-up timer clears the finished marker so the UI
    // doesn't double-render a stale "pomodoro done" panel.
    await useTimerStore.getState().startTimer("task-2", "2026-04-21");
    state = useTimerStore.getState();
    expect(state.pomodoroFinishedTaskId).toBeNull();
    expect(state.pomodoroFinishedFlowDate).toBeNull();
    expect(state.pomodoroFinishedTargetSeconds).toBeNull();
  });

  it("clears the finished-pomodoro slot on restart via startPomodoro", async () => {
    const fetchMock = createTimerFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await useTimerStore.getState().startPomodoro("task-1", "2026-04-21", 3);
    await vi.advanceTimersByTimeAsync(3000);
    expect(useTimerStore.getState().pomodoroFinishedTaskId).toBe("task-1");

    await useTimerStore.getState().startPomodoro("task-1", "2026-04-21", 60);
    const state = useTimerStore.getState();
    expect(state.pomodoroFinishedTaskId).toBeNull();
    expect(state.activeTaskId).toBe("task-1");
    expect(state.timerMode).toBe("pomodoro");
  });

  it("dismissPomodoroFinished clears the marker without touching the active timer", async () => {
    vi.stubGlobal("fetch", createTimerFetchMock());

    useTimerStore.setState({
      pomodoroFinishedTaskId: "task-1",
      pomodoroFinishedFlowDate: "2026-04-21",
      pomodoroFinishedTargetSeconds: 60,
    });
    useTimerStore.getState().dismissPomodoroFinished();
    const state = useTimerStore.getState();
    expect(state.pomodoroFinishedTaskId).toBeNull();
    expect(state.pomodoroFinishedFlowDate).toBeNull();
    expect(state.pomodoroFinishedTargetSeconds).toBeNull();
    // No timer was running — status must remain idle.
    expect(state.status).toBe("idle");
    expect(state.activeTaskId).toBeNull();
  });

  it("hydrateSession clears stale local timer state when the server has no session", async () => {
    const fetchMock = createTimerFetchMock({ timerSession: null });
    vi.stubGlobal("fetch", fetchMock);

    useTimerStore.setState({
      activeTaskId: "task-1",
      activeFlowDate: "2026-04-21",
      status: "running",
      timerMode: "pomodoro",
      pomodoroTargetSeconds: 1800,
      segmentWallStart: "2026-04-21T09:00:00.000Z",
      segmentStartedAt: Date.now(),
      sessionSavedSeconds: 120,
      priorSeconds: 0,
      displaySeconds: 1680,
      pomodoroFinishedTaskId: "task-old",
      pomodoroFinishedFlowDate: "2026-04-20",
      pomodoroFinishedTargetSeconds: 900,
    });

    await useTimerStore.getState().hydrateSession();

    const state = useTimerStore.getState();
    expect(state.activeTaskId).toBeNull();
    expect(state.activeFlowDate).toBeNull();
    expect(state.status).toBe("idle");
    expect(state.timerMode).toBe("countup");
    expect(state.pomodoroTargetSeconds).toBeNull();
    expect(state.displaySeconds).toBe(0);
    expect(state.pomodoroFinishedTaskId).toBeNull();
    expect(state.pomodoroFinishedFlowDate).toBeNull();
    expect(state.pomodoroFinishedTargetSeconds).toBeNull();
  });

  it("does not chime for count-up timers regardless of elapsed time", async () => {
    const fetchMock = createTimerFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await useTimerStore.getState().startTimer("task-1", "2026-04-13");
    await vi.advanceTimersByTimeAsync(60_000);
    await useTimerStore.getState().stopAndSave();

    expect(_getChimeCount()).toBe(0);
  });

  it("saves misc timer entries under the daily sentinel id", async () => {
    const posts: EntryPostBody[] = [];
    const fetchMock = createTimerFetchMock({
      onEntryPost: (body) => posts.push(body),
    });
    vi.stubGlobal("fetch", fetchMock);

    const miscTaskId = buildMiscTaskId("2026-04-13");
    await useTimerStore.getState().startTimer(miscTaskId, "2026-04-13");
    await vi.advanceTimersByTimeAsync(5000);
    await useTimerStore.getState().stopAndSave();

    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      taskId: miscTaskId,
      flowDate: "2026-04-13",
      durationS: 5,
      source: "timer",
    });
  });
});
