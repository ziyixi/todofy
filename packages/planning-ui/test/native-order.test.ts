import { expect, it } from "vitest";
import { outcomeSteps } from "../src/planning-outcomes";
import { applyConfirmed } from "../src/plan-updates";
import type { PlanningTask, PlusData } from "../src/model";
const root: PlanningTask = {
  id: "parent",
  title: "Synthetic outcome",
  parentId: "",
  projectId: "inbox",
  area: "work",
  stage: "committed",
  priority: 1,
  deadline: "",
  due: "",
  leadDays: 0,
  etag: "1",
  mustStart: false,
  missingLead: false,
};
it("keeps fractional native sibling positions without truncating to Todoist child_order", () => {
  const tasks = [
    root,
    {
      ...root,
      id: "later",
      parentId: "parent",
      stage: "none" as const,
      sortOrder: 1.5,
    },
    {
      ...root,
      id: "earlier",
      parentId: "parent",
      stage: "none" as const,
      sortOrder: 1.25,
    },
  ];
  expect(outcomeSteps(root, tasks).map((task) => task.id)).toEqual([
    "earlier",
    "later",
  ]);
});

it("keeps confirmed reorder etags for the next write while preserving task properties", () => {
  const task = {
    ...root,
    kind: "task" as const,
    explicitStage: "committed" as const,
    planningFlags: ["active"],
    estimatedMinutes: 45,
    sortOrder: 1,
  };
  const sibling = { ...task, id: "sibling", sortOrder: 2 };
  const unrelated = { ...task, id: "unrelated", parentId: "other" };
  const data: PlusData = {
    plan: {
      tasks: [task, sibling, unrelated],
      week: "2026-10-19",
      today: "2026-10-19",
      timezone: "UTC",
      nextWeekTaskIds: [],
      dependencies: [],
      weeklyBets: [],
      laneOrders: {},
    },
    focus: {
      date: "2026-10-19",
      taskIds: [],
      completedTaskIds: [],
      entries: [],
      timerEtag: "0",
      estimates: {},
      tasks: {},
    },
    days: [],
  };

  const confirmed = applyConfirmed(data, {
    reordered: [
      {
        ...task,
        title: "Older synthetic title",
        estimatedMinutes: undefined,
        planningFlags: [],
        stage: "weekly",
        explicitStage: "weekly",
        etag: "reordered-parent",
        sortOrder: 2,
        updatedAt: "2026-10-19T01:00:00Z",
      },
      { ...sibling, etag: "reordered-sibling", sortOrder: 1 },
    ],
    lane: { lane: "committed", taskIds: [sibling.id, task.id] },
  });

  expect(confirmed.plan.tasks).toEqual([
    {
      ...task,
      childOrder: undefined,
      orderKey: undefined,
      etag: "reordered-parent",
      sortOrder: 2,
      updatedAt: "2026-10-19T01:00:00Z",
    },
    {
      ...sibling,
      childOrder: undefined,
      orderKey: undefined,
      etag: "reordered-sibling",
      sortOrder: 1,
      updatedAt: undefined,
    },
    unrelated,
  ]);
  expect(confirmed.plan.laneOrders.committed).toEqual([sibling.id, task.id]);
  expect(confirmed.focus).toBe(data.focus);
  expect(confirmed.days).toBe(data.days);
});
