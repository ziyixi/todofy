import { expect, it } from "vitest";
import { outcomeSteps } from "../src/planning-outcomes";
import type { PlanningTask } from "../src/model";
const root: PlanningTask = {
  id: "parent",
  title: "Synthetic outcome",
  parentId: "",
  projectId: "inbox",
  labels: [],
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
