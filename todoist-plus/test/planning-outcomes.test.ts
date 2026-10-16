import { expect, it } from "vitest";
import {
  outcomeForTask,
  outcomeSteps,
  planningOutcomes,
} from "../src/planning-outcomes";
import type { PlanningTask } from "../src/model";

function task(id: string, changes: Partial<PlanningTask> = {}): PlanningTask {
  return {
    id,
    title: id,
    parentId: "",
    projectId: "",
    labels: [],
    area: "work",
    stage: "none",
    priority: 1,
    deadline: "",
    leadDays: 0,
    due: "",
    etag: "",
    mustStart: false,
    missingLead: false,
    ...changes,
  };
}

it("ties a same-stage child and its steps to the overall commitment", () => {
  const goal = task("goal");
  const commitment = task("commitment", {
    parentId: goal.id,
    stage: "committed",
  });
  const child = task("child", { parentId: commitment.id, stage: "committed" });
  const step = task("step", { parentId: child.id });
  const tasks = [goal, commitment, child, step];

  expect(outcomeForTask(child, tasks).id).toBe(commitment.id);
  expect(outcomeForTask(step, tasks).id).toBe(commitment.id);
  expect(outcomeSteps(commitment, tasks).map((item) => item.id)).toEqual([
    step.id,
  ]);
});

it("keeps an independently committed subtree under a quarterly goal distinct", () => {
  const quarter = task("quarter", { stage: "quarterly" });
  const commitment = task("commitment", {
    parentId: quarter.id,
    stage: "committed",
  });
  const committedStep = task("committed-step", { parentId: commitment.id });
  const quarterStep = task("quarter-step", { parentId: quarter.id });
  const tasks = [quarter, commitment, committedStep, quarterStep];

  expect(outcomeForTask(committedStep, tasks).id).toBe(commitment.id);
  expect(outcomeForTask(quarterStep, tasks).id).toBe(quarter.id);
  expect(outcomeSteps(quarter, tasks).map((item) => item.id)).toEqual([
    quarterStep.id,
  ]);
  expect(outcomeSteps(commitment, tasks).map((item) => item.id)).toEqual([
    committedStep.id,
  ]);
});

it("uses the immediate parent when no task in the ancestry has a planning stage", () => {
  const goal = task("goal");
  const parent = task("parent", { parentId: goal.id });
  const step = task("step", { parentId: parent.id });
  expect(outcomeForTask(step, [goal, parent, step]).id).toBe(parent.id);
  expect(outcomeForTask(goal, [goal, parent, step]).id).toBe(goal.id);
});

it("keeps a dated child with its commitment while an explicitly weekly child stays independent", () => {
  const labels = [{ role: "focus", id: "weekly-id", label: "weekly-choice" }];
  const commitment = task("commitment", {
    stage: "committed",
    labels: ["committed"],
  });
  const datedStep = task("dated-step", {
    parentId: commitment.id,
    stage: "weekly",
    due: "2026-10-15",
  });
  const independent = task("independent", {
    parentId: commitment.id,
    stage: "weekly",
    due: "2026-10-15",
    labels: ["weekly-choice"],
  });
  const datedRoot = task("dated-root", { stage: "weekly", due: "2026-10-15" });
  const tasks = [commitment, datedStep, independent, datedRoot];

  expect(
    outcomeSteps(commitment, tasks, labels).map((item) => item.id),
  ).toEqual([datedStep.id]);
  expect(outcomeForTask(datedStep, tasks, labels).id).toBe(commitment.id);
  expect(outcomeForTask(independent, tasks, labels).id).toBe(independent.id);
  expect(planningOutcomes(tasks, labels).map((item) => item.id)).toEqual([
    commitment.id,
    independent.id,
    datedRoot.id,
  ]);
});
