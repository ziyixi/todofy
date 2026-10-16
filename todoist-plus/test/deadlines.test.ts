import { expect, it } from "vitest";
import {
  deadlineState,
  deadlineStatus,
  detailStatus,
  spokenDeadline,
  startStatus,
  unplannedDue,
  unplannedText,
} from "../src/deadlines";
import { addDays, displayedTitle } from "../src/domain";
import type { PlanningTask } from "../src/model";

// The design's synthetic "today", a Thursday.
const TODAY = "2026-10-15";
const task = (id: string, value: Partial<PlanningTask> = {}): PlanningTask => ({
  id,
  title: `Synthetic ${id}`,
  parentId: "",
  projectId: "synthetic",
  labels: [],
  area: "work",
  stage: "none",
  priority: 1,
  deadline: "",
  due: "",
  leadDays: 0,
  etag: id,
  mustStart: false,
  missingLead: false,
  ...value,
});
const on = (days: number) => addDays(TODAY, days);

it("gives each task with a deadline the first matching state, from Todofy's flags", () => {
  const states = [
    task("none", { mustStart: true }),
    task("parked", { deadline: on(-2), labels: ["parked"], mustStart: true }),
    task("active", { deadline: on(12), labels: ["active"] }),
    // @active with @blocked is not in progress: Todofy's in-progress deadline query excludes it.
    task("blockedActive", {
      deadline: on(3),
      labels: ["active", "blocked"],
      missingLead: true,
    }),
    task("past", { deadline: on(-2), mustStart: true }),
    task("window", { deadline: on(5), leadDays: 7, mustStart: true }),
    task("noLead", { deadline: on(46), missingLead: true }),
    task("later", { deadline: on(30), leadDays: 7 }),
  ].map((item) => [item.id, deadlineState(item, TODAY)]);
  expect(Object.fromEntries(states)).toEqual({
    none: undefined,
    parked: undefined,
    active: { kind: "active", days: 12 },
    blockedActive: { kind: "noLead", days: 3 },
    past: { kind: "past", days: -2 },
    window: { kind: "window", days: 5 },
    noLead: { kind: "noLead", days: 46 },
    later: undefined,
  });
});

it("says how long a task that should start has left, only days past in the danger colour", () => {
  const statuses = [on(-2), TODAY, on(1), on(5)].map((deadline) => [
    startStatus(deadline, TODAY, "zh"),
    startStatus(deadline, TODAY, "en"),
  ]);
  expect(statuses).toEqual([
    [
      { text: "", danger: "已过 2 天" },
      { text: "", danger: "2 days late" },
    ],
    [{ text: "今天截止" }, { text: "Deadline today" }],
    [{ text: "明天截止" }, { text: "Deadline tomorrow" }],
    [{ text: "还剩 5 天" }, { text: "5 days left" }],
  ]);
  expect(startStatus(on(-1), TODAY, "en")).toEqual({
    text: "",
    danger: "1 day late",
  });
});

it("tells screen readers only the part of the deadline a status does not say", () => {
  const spoken = (status: string, deadline: string, language: "zh" | "en") =>
    spokenDeadline({ text: status }, deadline, language);
  expect(spoken("11月30日截止", "2026-11-30", "zh")).toBe("，周一");
  expect(spoken("Deadline Nov 30", "2026-11-30", "en")).toBe(", Mon");
  expect(spoken("明天截止", on(1), "zh")).toBe("，10月16日周五");
  expect(spoken("5 days left", on(5), "en")).toBe(", Tue, Oct 20");
  expect(spokenDeadline({ text: "", danger: "已过 2 天" }, on(-2), "zh")).toBe(
    "，10月13日周二",
  );
});

it("says in task details where the deadline stands, from the fields as shown", () => {
  const plain = task("plain");
  const status = (deadline: string, lead: number, item = plain) =>
    detailStatus(item, deadline, lead, TODAY, "zh");
  expect(status("", 7)).toBeUndefined();
  expect(status(on(15), 7)).toEqual({ text: "启动窗口: 10月24日周六" });
  expect(status(on(5), 7)).toEqual({ text: "已到启动窗口 · 还剩 5 天" });
  expect(status(on(1), 3)).toEqual({ text: "已到启动窗口 · 明天截止" });
  expect(status(on(-2), 7)).toEqual({ text: "", danger: "已过截止 2 天" });
  // Without a start-ahead choice the select already says "Not set".
  expect(status(on(40), 0)).toBeUndefined();
  const active = task("active", { labels: ["active"] });
  expect(status(on(12), 7, active)).toEqual({ text: "进行中 · 还剩 12 天" });
  expect(detailStatus(plain, on(5), 7, TODAY, "en")).toEqual({
    text: "Start window open · 5 days left",
  });
  expect(detailStatus(plain, on(15), 7, TODAY, "en")).toEqual({
    text: "Start window: Sat, Oct 24",
  });
});

it("names a deadline's date, today and tomorrow in words, and days past in the danger colour", () => {
  expect(deadlineStatus(task("plain"), TODAY, "zh")).toBeUndefined();
  expect(
    deadlineStatus(task("contract", { deadline: on(7) }), TODAY, "zh"),
  ).toEqual({ text: "10月22日截止" });
  expect(
    deadlineStatus(task("contract", { deadline: on(7) }), TODAY, "en"),
  ).toEqual({ text: "Deadline Oct 22" });
  expect(
    deadlineStatus(task("soon", { deadline: on(1) }), TODAY, "zh"),
  ).toEqual({ text: "明天截止" });
  expect(
    deadlineStatus(task("late", { deadline: on(-2) }), TODAY, "zh"),
  ).toEqual({ text: "", danger: "已过截止 2 天" });
});

it("counts tasks that should start once, unless the task or an open step is planned in these queues", () => {
  const tasks = [
    task("past", { deadline: on(-1), mustStart: true }),
    task("window", { deadline: on(3), leadDays: 7, mustStart: true }),
    task("planned", { deadline: on(2), leadDays: 3, mustStart: true }),
    task("parent", { deadline: on(4), leadDays: 7, mustStart: true }),
    task("step", { parentId: "parent" }),
    task("done-step-parent", { deadline: on(4), leadDays: 7, mustStart: true }),
    task("done-step", { parentId: "done-step-parent" }),
    task("noLead", { deadline: on(2), missingLead: true }),
    task("active", { deadline: on(2), labels: ["active"] }),
    // Todofy marks a waiting task past its deadline must start, but the board shows it in Waiting.
    task("waiting", { deadline: on(-2), labels: ["waiting"], mustStart: true }),
  ];
  const days = [
    {
      date: TODAY,
      taskIds: ["planned", "done-step"],
      completedTaskIds: ["done-step"],
    },
    { date: on(1), taskIds: ["step"], completedTaskIds: [] },
  ];
  const counts = unplannedDue(tasks, days, TODAY);
  expect(counts).toEqual({ past: 1, window: 2 });
  expect(unplannedText(counts, "zh")).toBe(
    "1 项已过截止、2 项已到启动窗口，这周还没有安排",
  );
  expect(unplannedText({ past: 1, window: 1 }, "en")).toBe(
    "1 past deadline and 1 in its start window, not planned this week",
  );
  expect(unplannedText({ past: 0, window: 2 }, "zh")).toBe(
    "2 项已到启动窗口，这周还没有安排",
  );
  expect(unplannedText({ past: 0, window: 2 }, "en")).toBe(
    "2 in their start window, not planned this week",
  );
});

it("hides legacy key suffixes with spaces in Plus's own views", () => {
  expect(displayedTitle("Quarterly report <k:report dep:draft,data>")).toBe(
    "Quarterly report",
  );
  expect(displayedTitle("Draft <k:draft>")).toBe("Draft");
  expect(displayedTitle("<k:only>")).toBe("<k:only>");
});
