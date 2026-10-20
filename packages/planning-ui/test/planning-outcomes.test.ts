import { expect, it } from "vitest";
import {
  areaColor,
  outcomeForTask,
  outcomeSteps,
  planningOutcomes,
  stepSiblings,
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

it("lists next steps depth first in Todoist's order of each parent's children", () => {
  const outcome = task("outcome", { stage: "committed" });
  const ids = (tasks: PlanningTask[]) =>
    outcomeSteps(outcome, tasks).map((item) => item.id);
  // Listed out of order: Todoist's positions decide, at every depth.
  const tasks = [
    outcome,
    task("b", { parentId: "outcome", childOrder: 2 }),
    task("b2", { parentId: "b", childOrder: 9 }),
    task("b1", { parentId: "b", childOrder: 4 }),
    task("a", { parentId: "outcome", childOrder: 1 }),
    task("c", { parentId: "outcome", childOrder: 3 }),
  ];
  expect(ids(tasks)).toEqual(["a", "b1", "b2", "c"]);
  expect(stepSiblings(tasks[5]!, tasks).map((item) => item.id)).toEqual([
    "a",
    "b",
    "c",
  ]);
  expect(stepSiblings(outcome, tasks)).toEqual([]);
  // Order keys, compared bytewise, win when every sibling has one.
  const keyed = tasks.map((item) =>
    item.parentId === "outcome"
      ? {
          ...item,
          orderKey: { a: "a2", b: "a1", c: "a10" }[item.id as "a" | "b" | "c"],
        }
      : item,
  );
  expect(ids(keyed)).toEqual(["b1", "b2", "c", "a"]);
  // One sibling without a key: positions again, for that group only.
  const partly = keyed.map((item) =>
    item.id === "c" ? { ...item, orderKey: undefined } : item,
  );
  expect(ids(partly)).toEqual(["a", "b1", "b2", "c"]);
  // Without positions the list's order stays; an unknown position comes last.
  const unknown = tasks.map((item) => ({ ...item, childOrder: undefined }));
  expect(ids(unknown)).toEqual(["b2", "b1", "a", "c"]);
  expect(
    ids(
      tasks.map((item) =>
        item.id === "a" ? { ...item, childOrder: undefined } : item,
      ),
    ),
  ).toEqual(["b1", "b2", "c", "a"]);
});

it("colours a card by its area, its own or its nearest ancestor's, and gives Unassigned no colour", () => {
  const project = task("project", { area: "unassigned" });
  const outcome = task("outcome", { parentId: project.id, stage: "committed" });
  const step = task("step", { parentId: outcome.id, area: "unassigned" });
  const errand = task("errand", { area: "personal" });
  const loose = task("loose", { area: "unassigned" });
  const tasks = [project, outcome, step, errand, loose];
  expect(areaColor(step, tasks)).toBe("var(--plus-area-work)");
  expect(areaColor(outcome, tasks)).toBe("var(--plus-area-work)");
  expect(areaColor(errand, tasks)).toBe("var(--plus-area-personal)");
  expect(areaColor(loose, tasks)).toBe("var(--plus-area-none)");
  expect(areaColor(project, tasks)).toBe("var(--plus-area-none)");
  // A parent loop ends the search instead of looping.
  const a = task("a", { parentId: "b", area: "unassigned" });
  const b = task("b", { parentId: "a", area: "unassigned" });
  expect(areaColor(a, [a, b])).toBe("var(--plus-area-none)");
});
