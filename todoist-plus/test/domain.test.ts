import { describe, expect, it } from "vitest";
import {
  displayedTitle,
  effectiveArea,
  executionChoices,
  moveTask,
  startDate,
  topLevelChoices,
  topLevelBets,
} from "../src/domain";
import type { PlanningTask } from "../src/model";
const task = (
  id: string,
  changes: Partial<PlanningTask> = {},
): PlanningTask => ({
  id,
  title: id,
  parentId: "",
  projectId: "",
  labels: [],
  area: "work",
  stage: "none",
  bet: false,
  deadline: "",
  leadDays: 0,
  due: "",
  etag: "",
  mustStart: false,
  missingLead: false,
  ...changes,
});

describe("planning choices", () => {
  it("counts a committed parent once, keeping its children available for execution", () => {
    const tasks = [
      task("parent", { stage: "committed" }),
      task("child", {
        parentId: "parent",
        stage: "committed",
        area: "unassigned",
      }),
      task("candidate", { stage: "weekly" }),
      task("quick", { labels: ["quick"] }),
    ];
    expect(topLevelChoices(tasks, "work").map((item) => item.id)).toEqual([
      "parent",
      "candidate",
      "quick",
    ]);
    expect(executionChoices(tasks).map((item) => item.id)).toEqual([
      "child",
      "quick",
    ]);
    expect(effectiveArea(tasks[1]!, tasks)).toBe("work");
  });
  it("leaves unrelated title syntax intact while removing known display-only markers", () => {
    expect(displayedTitle("[EXP] Example <k:abc-1>")).toBe("Example");
    expect(displayedTitle("[Important] Review <key:abc>")).toBe(
      "[Important] Review <key:abc>",
    );
  });
  it("matches the existing exclusive deadline filter across year boundaries", () => {
    expect(startDate("2027-01-10", 30)).toBe("2026-12-12");
    expect(startDate("2027-01-10", 0)).toBe("");
  });
  it("reorders the chosen task while retaining every other queued ID", () => {
    expect(moveTask(["a", "local-keep", "b"], "b", -1)).toEqual([
      "a",
      "b",
      "local-keep",
    ]);
    expect(moveTask(["a", "b"], "a", -1)).toEqual(["a", "b"]);
  });
});

it("counts a committed ancestor and descendant once within Committed", () => {
  const tasks = [
    task("parent", { stage: "committed" }),
    task("child", { stage: "committed", parentId: "parent" }),
  ];
  expect(topLevelChoices(tasks, "work").map((item) => item.id)).toEqual([
    "parent",
  ]);
});
it("keeps a committed child visible below a monthly parent", () => {
  const tasks = [
    task("parent", { stage: "monthly" }),
    task("child", { stage: "committed", parentId: "parent" }),
  ];
  expect(
    topLevelChoices(tasks, "work").map((item) => [item.id, item.stage]),
  ).toEqual([
    ["parent", "monthly"],
    ["child", "committed"],
  ]);
});
it("keeps a committed child visible below a weekly parent", () => {
  const tasks = [
    task("parent", { stage: "weekly" }),
    task("child", { stage: "committed", parentId: "parent" }),
  ];
  expect(
    topLevelChoices(tasks, "work").map((item) => [item.id, item.stage]),
  ).toEqual([
    ["parent", "weekly"],
    ["child", "committed"],
  ]);
});
it("deduplicates Bets independently of commitment stages", () => {
  const parent = task("parent", { stage: "committed" });
  const child = task("child", {
    stage: "committed",
    parentId: "parent",
    bet: true,
  });
  expect(topLevelBets([parent, child], "work").map((item) => item.id)).toEqual([
    "child",
  ]);
  expect(
    topLevelBets([{ ...parent, bet: true }, child], "work").map(
      (item) => item.id,
    ),
  ).toEqual(["parent"]);
});
