import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import {
  ListPlanningTasksResponseSchema,
  PlanningTaskSchema,
  SetTaskPlanResponseSchema,
  SetTaskLeadResponseSchema,
} from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import { clearDetailReadCache } from "./detail-read-cache";
import {
  planningApi,
  planningDraft,
  peekTaskPlanning,
  readCachedTaskPlanning,
  saveTaskPlanning,
} from "./task-planning";
import { clearTaskStartAhead } from "./task-date-actions";
import { useTaskPlanning } from "./useTaskPlanning";

const task = create(TaskSchema, {
  id: "synthetic",
  name: "tasks/synthetic",
  title: "Synthetic cached task",
  etag: "1",
});
const known = create(PlanningTaskSchema, {
  id: task.id,
  etag: "planning-known",
  explicitStage: "committed",
  area: "work",
  leadDays: 14,
  planningFlags: ["task", "waiting"],
});
const answer = (value = known) =>
  create(ListPlanningTasksResponseSchema, { planningTasks: [value] });
beforeEach(clearDetailReadCache);
afterEach(() => {
  cleanup();
  clearDetailReadCache();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("Quick enables standalone immediately and keeps it after Quick is cleared", () => {
  const { result } = renderHook(() => useTaskPlanning());
  act(() => result.current.patch("quick", true));
  expect(result.current.draft.singleAction).toBe(true);
  act(() => result.current.patch("quick", false));
  expect(result.current.draft.singleAction).toBe(true);
  act(() => result.current.patch("singleAction", false));
  expect(result.current.draft.singleAction).toBe(false);
  expect(
    planningDraft(create(PlanningTaskSchema, { planningFlags: ["quick"] }))
      .singleAction,
  ).toBe(true);
});

it("opens warm planning details with known checked values and no loading placeholder", async () => {
  const read = vi
    .spyOn(planningApi, "listPlanningTasks")
    .mockResolvedValue(answer());
  await readCachedTaskPlanning(task);
  const { result } = renderHook(() => useTaskPlanning(task));
  expect(result.current.loading).toBe(false);
  expect(result.current.draft).toMatchObject({
    stage: "committed",
    singleAction: true,
    waiting: true,
    leadDays: 14,
  });
  expect(read).toHaveBeenCalledTimes(1);
});

it("keeps expired planning unknown until a real read confirms current values", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
  const read = vi
    .spyOn(planningApi, "listPlanningTasks")
    .mockResolvedValue(answer());
  await readCachedTaskPlanning(task);
  vi.setSystemTime(new Date("2026-10-18T12:00:31Z"));
  const fresh = create(PlanningTaskSchema, {
    ...known,
    etag: "fresh",
    planningFlags: ["routine"],
  });
  let resolve!: (value: ReturnType<typeof answer>) => void;
  const pending = new Promise<ReturnType<typeof answer>>((done) => {
    resolve = done;
  });
  read.mockReturnValue(pending);
  const { result } = renderHook(() => useTaskPlanning(task));
  expect(result.current.loading).toBe(true);
  await act(async () => {
    resolve(answer(fresh));
  });
  expect(result.current.loading).toBe(false);
  expect(result.current.draft).toMatchObject({
    singleAction: false,
    waiting: false,
    routine: true,
  });
});

it("does not reuse planning from another generic task etag", async () => {
  const read = vi
    .spyOn(planningApi, "listPlanningTasks")
    .mockResolvedValue(answer());
  await readCachedTaskPlanning(task);
  let resolve!: (value: ReturnType<typeof answer>) => void;
  const pending = new Promise<ReturnType<typeof answer>>((done) => {
    resolve = done;
  });
  read.mockReturnValue(pending);
  const { result } = renderHook(() =>
    useTaskPlanning(create(TaskSchema, { ...task, etag: "2" })),
  );
  expect(result.current.loading).toBe(true);
  await act(async () => {
    resolve(
      answer(
        create(PlanningTaskSchema, { ...known, planningFlags: ["quick"] }),
      ),
    );
  });
  expect(result.current.draft).toMatchObject({
    singleAction: true,
    quick: true,
    waiting: false,
  });
});

it("keeps an edited draft when the page cache is invalidated", async () => {
  const read = vi
    .spyOn(planningApi, "listPlanningTasks")
    .mockResolvedValue(answer());
  await readCachedTaskPlanning(task);
  const { result, rerender } = renderHook(() => useTaskPlanning(task));
  act(() => result.current.patch("waiting", false));
  clearDetailReadCache();
  rerender();
  expect(result.current.draft.waiting).toBe(false);
  expect(result.current.loading).toBe(false);
  expect(read).toHaveBeenCalledTimes(1);
});

it("saves against a fresh planning etag and preserves unrelated server changes", async () => {
  const read = vi
    .spyOn(planningApi, "listPlanningTasks")
    .mockResolvedValue(answer());
  await readCachedTaskPlanning(task);
  const fresh = create(PlanningTaskSchema, {
    ...known,
    etag: "fresh-server-etag",
    planningFlags: ["task", "waiting", "quick"],
  });
  read.mockResolvedValue(answer(fresh));
  const save = vi
    .spyOn(planningApi, "setTaskPlan")
    .mockResolvedValue(create(SetTaskPlanResponseSchema, { task: fresh }));
  await saveTaskPlanning(
    task.id,
    "",
    { ...planningDraft(known), routine: true },
    planningDraft(known),
  );
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ etag: "fresh-server-etag", routine: true }),
  );
  expect(save.mock.calls[0]![0]).not.toHaveProperty("quick");
});

it("refuses a planning conflict even when the opened details had a valid cache entry", async () => {
  const read = vi
    .spyOn(planningApi, "listPlanningTasks")
    .mockResolvedValue(answer());
  await readCachedTaskPlanning(task);
  read.mockResolvedValue(
    answer(
      create(PlanningTaskSchema, {
        ...known,
        explicitStage: "monthly",
        etag: "changed",
      }),
    ),
  );
  const save = vi.spyOn(planningApi, "setTaskPlan");
  await expect(
    saveTaskPlanning(
      task.id,
      "",
      { ...planningDraft(known), stage: "weekly" },
      planningDraft(known),
    ),
  ).rejects.toThrow("Planning changed elsewhere");
  expect(save).not.toHaveBeenCalled();
  expect(peekTaskPlanning(task)).toBeUndefined();
});

it("clears start-ahead using a fresh read rather than the cached old deadline", async () => {
  const read = vi
    .spyOn(planningApi, "listPlanningTasks")
    .mockResolvedValue(
      answer(create(PlanningTaskSchema, { ...known, deadline: "2030-01-01" })),
    );
  await readCachedTaskPlanning(task);
  const fresh = create(PlanningTaskSchema, {
    ...known,
    deadline: "",
    leadDays: 21,
    etag: "fresh-cleared-deadline",
  });
  read.mockResolvedValue(answer(fresh));
  const save = vi
    .spyOn(planningApi, "setTaskLead")
    .mockResolvedValue(create(SetTaskLeadResponseSchema, { task: fresh }));
  await clearTaskStartAhead(task.id);
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({
      etag: "fresh-cleared-deadline",
      deadline: "",
      leadDays: 0,
    }),
  );
});

it("does not restore a cached deadline when only start-ahead was edited", async () => {
  const cached = create(PlanningTaskSchema, {
    ...known,
    deadline: "2030-01-01",
  });
  const read = vi
    .spyOn(planningApi, "listPlanningTasks")
    .mockResolvedValue(answer(cached));
  await readCachedTaskPlanning(task);
  read.mockResolvedValue(
    answer(
      create(PlanningTaskSchema, {
        ...cached,
        deadline: "2030-02-01",
        etag: "new-deadline",
      }),
    ),
  );
  const save = vi.spyOn(planningApi, "setTaskLead");
  const saveStage = vi.spyOn(planningApi, "setTaskPlan");
  await expect(
    saveTaskPlanning(
      task.id,
      cached.deadline,
      { ...planningDraft(cached), leadDays: 21 },
      planningDraft(cached),
    ),
  ).rejects.toThrow("The deadline changed elsewhere");
  await expect(
    saveTaskPlanning(
      task.id,
      cached.deadline,
      { ...planningDraft(cached), stage: "weekly", leadDays: 21 },
      planningDraft(cached),
    ),
  ).rejects.toThrow("The deadline changed elsewhere");
  expect(save).not.toHaveBeenCalled();
  expect(saveStage).not.toHaveBeenCalled();
  expect(peekTaskPlanning(task)).toBeUndefined();
});

it("reports no planning change for an unchanged save and true after a confirmed flag write", async () => {
  vi.spyOn(planningApi, "listPlanningTasks").mockResolvedValue(answer());
  await readCachedTaskPlanning(task);
  const save = vi
    .spyOn(planningApi, "setTaskPlan")
    .mockResolvedValue(create(SetTaskPlanResponseSchema, { task: known }));
  const { result } = renderHook(() => useTaskPlanning(task));
  await act(async () => {
    expect(await result.current.save(task.id, "")).toBe(false);
  });
  expect(save).not.toHaveBeenCalled();
  act(() => result.current.patch("routine", true));
  await act(async () => {
    expect(await result.current.save(task.id, "")).toBe(true);
  });
  expect(save).toHaveBeenCalledWith(
    expect.objectContaining({ routine: true, etag: known.etag }),
  );
});

it("permits an unchanged planning save after a read failure without guessing a planning write", async () => {
  vi.spyOn(planningApi, "listPlanningTasks").mockRejectedValue(
    new TypeError("Synthetic planning outage"),
  );
  const save = vi.spyOn(planningApi, "setTaskPlan");
  const { result } = renderHook(() => useTaskPlanning(task));
  await act(async () => {});
  expect(result.current.error).not.toBe("");
  await act(async () => {
    expect(await result.current.save(task.id, "")).toBe(false);
  });
  expect(save).not.toHaveBeenCalled();
});
