import { expect, it } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import {
  TASK_OPTIONS,
  planningChanges,
  planningDraft,
} from "./task-planning";

it("builds planningDraft defaults and derives singleAction when quick is set", () => {
  expect(TASK_OPTIONS.map(([field]) => field)).toEqual([
    "singleAction",
    "quick",
    "active",
    "waiting",
    "onHold",
    "routine",
    "parked",
  ]);

  const empty = planningDraft();
  expect(empty).toEqual({
    stage: "none",
    area: "unassigned",
    leadDays: 0,
    singleAction: false,
    quick: false,
    active: false,
    waiting: false,
    onHold: false,
    routine: false,
    parked: false,
  });

  const withQuick = planningDraft(
    create(TaskSchema, {
      stage: "weekly",
      area: "work",
      leadDays: 5,
      planningFlags: ["quick", "routine"],
    }),
  );
  expect(withQuick.singleAction).toBe(true);
  expect(withQuick.quick).toBe(true);
  expect(withQuick.routine).toBe(true);
  expect(withQuick.waiting).toBe(false);
});

it("computes minimal planningChanges paths and serializes selected planningFlags in TASK_OPTIONS order", () => {
  const base = planningDraft(
    create(TaskSchema, {
      stage: "ready",
      area: "work",
      leadDays: 2,
      planningFlags: ["task"],
    }),
  );

  expect(planningChanges(base, base)).toEqual({
    paths: [],
    values: {
      stage: "ready",
      area: "work",
      leadDays: 2,
      planningFlags: ["task"],
    },
  });

  const changed = planningChanges(
    {
      ...base,
      stage: "committed",
      area: "personal",
      leadDays: 4,
      quick: true,
      active: true,
    },
    base,
  );
  expect(changed.paths).toEqual([
    "stage",
    "area",
    "lead_days",
    "planning_flags",
  ]);
  expect(changed.values).toEqual({
    stage: "committed",
    area: "personal",
    leadDays: 4,
    planningFlags: ["task", "quick", "active"],
  });
});
