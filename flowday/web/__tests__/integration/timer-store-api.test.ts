import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTimeEntry, getEntriesByTask } from "@/lib/db/queries/entries";
import { useTimerStore } from "@/features/timer/store";
import { derivePomodoroLoggedSeconds } from "@/lib/utils/pomodoro-progress";
import { _getChimeCount, _resetChime } from "@/lib/utils/chime";
import { buildMiscTaskId } from "@/lib/utils/misc-task";

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

async function dispatchFlowDayFetch(input: string | URL | Request, init?: RequestInit) {
  const entriesRoute = await import("@/app/api/entries/route");
  const timerSessionRoute = await import("@/app/api/timer/session/route");
  const rawUrl = typeof input === "string" ? input : input.toString();
  const url = rawUrl.startsWith("http")
    ? rawUrl
    : `http://localhost:3000${rawUrl}`;
  const method = init?.method ?? "GET";
  const pathname = new URL(url).pathname;
  const request = new Request(url, {
    method,
    headers: init?.headers,
    body: init?.body,
  });

  if (pathname === "/api/entries") {
    if (method === "GET") {
      return entriesRoute.GET(request);
    }

    if (method === "POST") {
      return entriesRoute.POST(request);
    }
  }

  if (pathname === "/api/timer/session") {
    if (method === "GET") {
      return timerSessionRoute.GET();
    }

    if (method === "PUT") {
      return timerSessionRoute.PUT(request);
    }

    if (method === "DELETE") {
      return timerSessionRoute.DELETE();
    }
  }

  throw new Error(`Unsupported method for test fetch: ${method} ${pathname}`);
}

describe("timer store -> entries API integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T09:00:00.000Z"));
    resetTimerStore();
    _resetChime();
    vi.stubGlobal("fetch", dispatchFlowDayFetch as typeof fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetTimerStore();
    _resetChime();
  });

  it("persists prior timer entry when switching tasks", async () => {
    await useTimerStore.getState().startTimer("task-1", "2026-04-13");
    await vi.advanceTimersByTimeAsync(5000);
    await useTimerStore.getState().startTimer("task-2", "2026-04-13");

    const task1Entries = getEntriesByTask("task-1");
    expect(task1Entries).toHaveLength(1);
    expect(task1Entries[0]).toMatchObject({
      taskId: "task-1",
      flowDate: "2026-04-13",
      durationS: 5,
      source: "timer",
    });

    const state = useTimerStore.getState();
    expect(state.activeTaskId).toBe("task-2");
    expect(state.status).toBe("running");
  });

  it("persists pomodoro as a normal timer entry and clears active state on completion", async () => {
    await useTimerStore.getState().startPomodoro("task-1", "2026-04-13", 3);
    await vi.advanceTimersByTimeAsync(3000);

    const entries = getEntriesByTask("task-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      taskId: "task-1",
      flowDate: "2026-04-13",
      durationS: 3,
      source: "timer",
    });

    const state = useTimerStore.getState();
    expect(state.activeTaskId).toBeNull();
    expect(state.status).toBe("idle");
  });

  it("fires the completion chime once when a pomodoro reaches zero and the entry is persisted", async () => {
    expect(_getChimeCount()).toBe(0);

    await useTimerStore.getState().startPomodoro("task-2", "2026-04-13", 2);
    await vi.advanceTimersByTimeAsync(2000);

    // Chime fired exactly once at completion.
    expect(_getChimeCount()).toBe(1);

    // And the corresponding time entry is durably stored via the real API route.
    const entries = getEntriesByTask("task-2");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      taskId: "task-2",
      flowDate: "2026-04-13",
      durationS: 2,
      source: "timer",
    });

    // Pausing/stopping a count-up timer must not produce additional chimes.
    await useTimerStore.getState().startTimer("task-3", "2026-04-13");
    await vi.advanceTimersByTimeAsync(5000);
    await useTimerStore.getState().stopAndSave();

    expect(_getChimeCount()).toBe(1);
  });

  it("combines prior logged time with the active pomodoro elapsed time", async () => {
    createTimeEntry({
      id: "prior-entry-1",
      taskId: "task-4",
      flowDate: "2026-04-13",
      startTime: "2026-04-13T08:00:00.000Z",
      endTime: "2026-04-13T08:02:00.000Z",
      durationS: 120,
      source: "timer",
    });

    await useTimerStore.getState().startPomodoro("task-4", "2026-04-13", 30 * 60);

    let state = useTimerStore.getState();
    expect(state.priorSeconds).toBe(120);
    expect(state.displaySeconds).toBe(30 * 60);
    expect(
      derivePomodoroLoggedSeconds(
        state.priorSeconds,
        state.pomodoroTargetSeconds,
        state.displaySeconds
      )
    ).toBe(120);

    await vi.advanceTimersByTimeAsync(120_000);

    state = useTimerStore.getState();
    expect(state.displaySeconds).toBe(28 * 60);
    expect(
      derivePomodoroLoggedSeconds(
        state.priorSeconds,
        state.pomodoroTargetSeconds,
        state.displaySeconds
      )
    ).toBe(240);
  });

  it("persists misc pomodoro entries under the daily sentinel id", async () => {
    const miscTaskId = buildMiscTaskId("2026-04-13");

    await useTimerStore.getState().startPomodoro(miscTaskId, "2026-04-13", 3);
    await vi.advanceTimersByTimeAsync(3000);

    const entries = getEntriesByTask(miscTaskId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      taskId: miscTaskId,
      flowDate: "2026-04-13",
      durationS: 3,
      source: "timer",
    });

    expect(useTimerStore.getState().pomodoroFinishedTaskId).toBe(miscTaskId);
  });
});
