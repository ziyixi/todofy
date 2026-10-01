import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveTimerSession,
  getActiveTimerSession,
  saveActiveTimerSession,
} from "@/lib/db/queries/timer-session";

describe("active timer session queries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T09:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("round-trips a saved session and refreshes updatedAt on overwrite", () => {
    saveActiveTimerSession({
      taskId: "task-1",
      flowDate: "2026-04-21",
      status: "running",
      timerMode: "pomodoro",
      pomodoroTargetS: 1800,
      segmentWallStart: "2026-04-21T09:00:00.000Z",
      sessionSavedS: 120,
      pomodoroFinishedTaskId: null,
      pomodoroFinishedFlowDate: null,
      pomodoroFinishedTargetS: null,
    });

    const first = getActiveTimerSession();
    expect(first).toMatchObject({
      taskId: "task-1",
      flowDate: "2026-04-21",
      status: "running",
      timerMode: "pomodoro",
      pomodoroTargetS: 1800,
      segmentWallStart: "2026-04-21T09:00:00.000Z",
      sessionSavedS: 120,
      pomodoroFinishedTaskId: null,
      pomodoroFinishedFlowDate: null,
      pomodoroFinishedTargetS: null,
    });
    expect(first?.updatedAt).toBe("2026-04-21T09:00:00.000Z");

    vi.setSystemTime(new Date("2026-04-21T09:05:00.000Z"));

    saveActiveTimerSession({
      taskId: "task-1",
      flowDate: "2026-04-21",
      status: "paused",
      timerMode: "pomodoro",
      pomodoroTargetS: 1800,
      segmentWallStart: null,
      sessionSavedS: 300,
      pomodoroFinishedTaskId: null,
      pomodoroFinishedFlowDate: null,
      pomodoroFinishedTargetS: null,
    });

    const second = getActiveTimerSession();
    expect(second).toMatchObject({
      status: "paused",
      sessionSavedS: 300,
      segmentWallStart: null,
    });
    expect(second?.updatedAt).toBe("2026-04-21T09:05:00.000Z");
  });

  it("hides the empty idle shape from callers", () => {
    saveActiveTimerSession({
      taskId: null,
      flowDate: null,
      status: "idle",
      timerMode: "countup",
      pomodoroTargetS: null,
      segmentWallStart: null,
      sessionSavedS: 0,
      pomodoroFinishedTaskId: null,
      pomodoroFinishedFlowDate: null,
      pomodoroFinishedTargetS: null,
    });

    expect(getActiveTimerSession()).toBeNull();
  });

  it("clears the singleton row", () => {
    saveActiveTimerSession({
      taskId: "task-2",
      flowDate: "2026-04-21",
      status: "paused",
      timerMode: "countup",
      pomodoroTargetS: null,
      segmentWallStart: null,
      sessionSavedS: 45,
      pomodoroFinishedTaskId: null,
      pomodoroFinishedFlowDate: null,
      pomodoroFinishedTargetS: null,
    });
    expect(getActiveTimerSession()).not.toBeNull();

    clearActiveTimerSession();

    expect(getActiveTimerSession()).toBeNull();
  });
});
