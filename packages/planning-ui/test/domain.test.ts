import { describe, expect, it } from "vitest";
import {
  clockTime,
  displayedTitle,
  effectiveArea,
  startDate,
  topLevelChoices,
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
});

describe("planning choices", () => {
  it("counts a committed parent once and inherits its area for its child", () => {
    const tasks = [
      task("parent", { stage: "committed" }),
      task("child", {
        parentId: "parent",
        stage: "committed",
        area: "unassigned",
      }),
      task("candidate", { stage: "weekly" }),
      task("quick", { planningFlags: ["quick"] }),
    ];
    expect(topLevelChoices(tasks, "work").map((item) => item.id)).toEqual([
      "parent",
      "candidate",
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

it("formats configured wall clocks with a 24-hour midnight and daylight-saving time", () => {
  expect(clockTime("2026-10-13T00:05:00Z", "UTC", "en")).toBe("00:05");
  expect(clockTime("2026-10-13T04:25:00Z", "Asia/Tokyo", "zh")).toBe("13:25");
  expect(clockTime("2026-11-01T08:30:00Z", "America/Los_Angeles", "en")).toBe(
    "01:30",
  );
  expect(clockTime("2026-11-01T09:30:00Z", "America/Los_Angeles", "en")).toBe(
    "01:30",
  );
});
