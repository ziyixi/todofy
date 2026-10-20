import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { elapsed, startDate } from "../src/domain";
import type { PlusActions, PlusData } from "../src/model";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const data = (): PlusData => ({
  plan: {
    tasks: [
      {
        id: "step",
        title: "Synthetic focused step",
        parentId: "parent",
        projectId: "inbox",
        kind: "step",
        labels: [],
        planningFlags: [],
        area: "work",
        stage: "none",
        priority: 1,
        deadline: "",
        due: "",
        leadDays: 0,
        etag: "1",
        mustStart: false,
        missingLead: false,
      },
    ],
    week: "2026-10-12",
    today: "2026-10-17",
    timezone: "UTC",
    configured: true,
    managedLabels: [],
    reviewTaskId: "",
    nextWeekTaskIds: [],
    dependencies: [],
    weeklyBets: [],
    laneOrders: {},
  },
  focus: {
    date: "2026-10-17",
    taskIds: ["step"],
    completedTaskIds: [],
    entries: [],
    timerEtag: "1",
    estimates: {},
    tasks: {},
  },
  days: [],
});
const props = (actions: PlusActions) => ({
  actions,
  view: "focus" as const,
  language: "en" as const,
  onOpenTask: vi.fn(),
  onSettings: vi.fn(),
});

it("opens native start windows exactly x days ahead and caps a hydrated session as Tasks does", () => {
  expect(startDate("2026-11-01", 21, true)).toBe("2026-10-11");
  const focus = {
    ...data().focus,
    timer: {
      taskId: "step",
      day: "2026-10-17",
      area: "work" as const,
      status: "running" as const,
      mode: "pomodoro" as const,
      targetSeconds: 60,
      elapsedSeconds: 40,
      startedAt: "2026-10-17T12:00:00Z",
      etag: "1",
    },
  };
  expect(elapsed(focus, Date.parse("2026-10-17T12:30:00Z"))).toBe(60);
  // Counting up stops at 4 hours, the most a session saves.
  const { mode: _mode, targetSeconds: _target, ...countUp } = focus.timer;
  expect(
    elapsed({ ...focus, timer: countUp }, Date.parse("2026-10-18T12:00:00Z")),
  ).toBe(4 * 60 * 60);
  expect(
    elapsed({ ...focus, timer: countUp }, Date.parse("2026-10-17T12:30:00Z")),
  ).toBe(40 + 30 * 60);
});

it("starts the selected pomodoro through the existing action and finishes a reloaded expired timer", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
  const loaded = data();
  const timer = vi.fn().mockResolvedValue({ timerEtag: "finished" });
  const actions = {
    load: vi.fn().mockResolvedValue(loaded),
    timer,
  } as unknown as PlusActions;
  render(<App {...props(actions)} />);
  await act(async () => {});
  fireEvent.change(screen.getByRole("combobox", { name: "Timer duration" }), {
    target: { value: "1500" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Start: Synthetic focused step" }),
  );
  await act(async () => {});
  expect(timer).toHaveBeenCalledWith(
    "start",
    "step",
    expect.anything(),
    1500,
    "work",
  );
  cleanup();
  loaded.focus.timer = {
    taskId: "step",
    day: "2026-10-17",
    area: "work",
    status: "running",
    mode: "pomodoro",
    targetSeconds: 60,
    elapsedSeconds: 20,
    startedAt: "2026-10-17T11:59:00Z",
    etag: "running",
  };
  render(<App {...props(actions)} />);
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(timer).toHaveBeenCalledWith(
    "finish",
    "step",
    expect.objectContaining({
      timer: expect.objectContaining({ etag: "running" }),
    }),
  );
  expect(
    screen.queryByRole("button", { name: "Pause: Synthetic focused step" }),
  ).toBeNull();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(
    timer.mock.calls.filter(([action]) => action === "finish"),
  ).toHaveLength(1);
});

it("reads another window's timer while visible without reloading task lists, then refreshes at midnight", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T23:58:30Z"));
  const loaded = data();
  const load = vi.fn().mockResolvedValue(loaded);
  const readTimer = vi.fn().mockResolvedValue({
    timerEtag: "other-window",
    timer: {
      taskId: "step",
      day: loaded.focus.date,
      area: "work",
      status: "paused",
      elapsedSeconds: 42,
      startedAt: "",
      etag: "other-window",
    },
  });
  render(<App {...props({ load, readTimer } as unknown as PlusActions)} />);
  await act(async () => {});
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(
    screen.getByRole("button", { name: "Resume: Synthetic focused step" }),
  ).toBeTruthy();
  expect(readTimer).toHaveBeenCalledTimes(1);
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(load).toHaveBeenCalledTimes(2);
});
