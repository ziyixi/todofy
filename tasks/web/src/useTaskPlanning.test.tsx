import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import { planningChanges, planningDraft } from "./task-planning";
import { useTaskPlanning } from "./useTaskPlanning";

afterEach(cleanup);

const task = create(TaskSchema, {
  name: "tasks/synthetic",
  id: "synthetic",
  etag: "3",
  stage: "weekly",
  area: "work",
  leadDays: 3,
  deadline: "2030-01-10",
  planningFlags: ["waiting"],
});

it("opens with the planning facts GetTask answered, and a new task with none", () => {
  expect(renderHook(() => useTaskPlanning(task)).result.current.draft).toEqual({
    stage: "weekly",
    area: "work",
    leadDays: 3,
    singleAction: false,
    quick: false,
    active: false,
    waiting: true,
    onHold: false,
    routine: false,
    parked: false,
  });
  expect(renderHook(() => useTaskPlanning()).result.current.draft).toEqual(
    planningDraft(),
  );
  expect(planningDraft()).toMatchObject({
    stage: "none",
    area: "unassigned",
    leadDays: 0,
  });
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
    planningDraft(create(TaskSchema, { planningFlags: ["quick"] }))
      .singleAction,
  ).toBe(true);
});

it("parks without a stage or in progress, and a stage or in progress takes it out of Parked", () => {
  const { result } = renderHook(() => useTaskPlanning(task));
  act(() => result.current.patch("active", true));
  act(() => result.current.patch("parked", true));
  expect(result.current.draft).toMatchObject({
    stage: "none",
    active: false,
    parked: true,
  });
  act(() => result.current.patch("stage", "monthly"));
  expect(result.current.draft.parked).toBe(false);
});

it("adds only the changed planning paths to the dialog's one write", () => {
  const base = planningDraft(task);
  expect(planningChanges(base, base).paths).toEqual([]);
  // A Saturday area edit sends no stage, so it never keeps a commitment for next week.
  expect(planningChanges({ ...base, area: "personal" }, base)).toMatchObject({
    paths: ["area"],
    values: { area: "personal" },
  });
  const quick = planningChanges(
    {
      ...base,
      stage: "committed",
      leadDays: 7,
      quick: true,
      singleAction: true,
    },
    base,
  );
  expect(quick.paths).toEqual(["stage", "lead_days", "planning_flags"]);
  expect(quick.values).toEqual({
    stage: "committed",
    area: "work",
    leadDays: 7,
    planningFlags: ["task", "quick", "waiting"],
  });
});
