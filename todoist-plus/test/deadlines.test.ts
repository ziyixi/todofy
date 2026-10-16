import { expect, it } from "vitest";
import {
  cardTitle,
  deadlineRows,
  deadlineState,
  detailStatus,
  isDue,
  rowStatus,
  spokenDeadline,
  unplannedDue,
  unplannedText,
  waitingDeadline,
} from "../src/deadlines";
import { addDays, displayedTitle } from "../src/domain";
import { oldestUntouched, WAITING_LABELS } from "../src/weekly-review";
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
  bet: false,
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
    // @active with @blocked is not in progress: Todofy's Active Deadlines excludes it.
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

it("lists deadlines earliest first, then by priority, with one short status each", () => {
  const tasks = [
    task("insurance", { deadline: on(46), missingLead: true }),
    task("move", { deadline: on(12), labels: ["active"] }),
    task("visa", { deadline: on(5), leadDays: 7, mustStart: true }),
    task("claim", { deadline: on(1), leadDays: 3, mustStart: true }),
    task("claimP1", {
      deadline: on(1),
      leadDays: 3,
      mustStart: true,
      priority: 4,
    }),
    task("report", { deadline: on(-2), leadDays: 7, mustStart: true }),
    task("later", { deadline: on(20), leadDays: 7 }),
  ];
  const rows = deadlineRows(tasks, TODAY);
  expect(rows.map((row) => row.task.id)).toEqual([
    "report",
    "claimP1",
    "claim",
    "visa",
    "move",
    "insurance",
  ]);
  expect(rows.map((row) => rowStatus(row, TODAY, "zh"))).toEqual([
    { text: "", danger: "已过 2 天" },
    { text: "明天截止" },
    { text: "明天截止" },
    { text: "还剩 5 天" },
    { text: "进行中 · 还剩 12 天" },
    { text: "11月30日截止" },
  ]);
  expect(rows.map((row) => rowStatus(row, TODAY, "en"))).toEqual([
    { text: "", danger: "2 days past" },
    { text: "Deadline tomorrow" },
    { text: "Deadline tomorrow" },
    { text: "5 days left" },
    { text: "In progress · 12 days left" },
    { text: "Deadline Nov 30" },
  ]);
  // Only "days past" is in the danger colour, also when in progress.
  const late = task("late", { deadline: on(-3), labels: ["active"] });
  expect(
    rowStatus({ task: late, state: deadlineState(late, TODAY)! }, TODAY, "zh"),
  ).toEqual({ text: "进行中 · ", danger: "已过 3 天" });
  const today = task("today", {
    deadline: TODAY,
    leadDays: 1,
    mustStart: true,
  });
  expect(
    rowStatus(
      { task: today, state: deadlineState(today, TODAY)! },
      TODAY,
      "en",
    ),
  ).toEqual({ text: "Deadline today" });
  // A @blocked task past its deadline without a lead says so, as past rows do.
  const blocked = task("blocked", {
    deadline: on(-2),
    labels: ["blocked"],
    missingLead: true,
  });
  expect(
    rowStatus(
      { task: blocked, state: deadlineState(blocked, TODAY)! },
      TODAY,
      "zh",
    ),
  ).toEqual({ text: "", danger: "已过 2 天" });
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

it("names the start window of a due card only", () => {
  const mark = (item: PlanningTask, language: "zh" | "en") => {
    const state = deadlineState(item, TODAY);
    return state && isDue(state) ? cardTitle(state, language) : "";
  };
  expect(
    mark(task("visa", { deadline: on(5), leadDays: 7, mustStart: true }), "zh"),
  ).toBe("已到启动窗口 · 还剩 5 天");
  expect(mark(task("late", { deadline: on(-2), mustStart: true }), "en")).toBe(
    "2 days past deadline",
  );
  expect(
    mark(task("move", { deadline: on(3), labels: ["active"] }), "en"),
  ).toBe("");
});

it("adds the deadline to Waiting rows, past deadlines in the danger colour", () => {
  expect(waitingDeadline(task("plain"), TODAY, "zh")).toBeUndefined();
  expect(
    waitingDeadline(task("contract", { deadline: on(7) }), TODAY, "zh"),
  ).toEqual({ text: "10月22日截止" });
  expect(
    waitingDeadline(task("contract", { deadline: on(7) }), TODAY, "en"),
  ).toEqual({ text: "Deadline Oct 22" });
  expect(
    waitingDeadline(task("late", { deadline: on(-2) }), TODAY, "zh"),
  ).toEqual({ text: "", danger: "已过截止 2 天" });
});

it("counts due tasks once, unless the task or an open step is planned in these queues", () => {
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

/**
 * The client half of the filter consistency gate (Todofy's tests/unit/test_plus.py checks the
 * server half): from the API's fields alone, Plus lists a task in Deadlines when it has a deadline,
 * is not parked and is in progress (`active` without `blocked`), must start or misses a lead; and in
 * Waiting when it has a `waiting` or `blocked` label.
 */
it("lists every task the API marks for a replaced deadline or waiting filter", () => {
  const marks = ["waiting", "blocked", "active", "parked"];
  for (let combination = 0; combination < 1 << marks.length; combination++)
    for (const deadline of ["", on(-3), TODAY, on(5), on(40)])
      for (const mustStart of [false, true])
        for (const missingLead of [false, true]) {
          const item = task("grid", {
            labels: marks.filter((_, bit) => (combination >> bit) & 1),
            deadline,
            mustStart,
            missingLead,
          });
          const labels = new Set(item.labels);
          const deadlines =
            Boolean(deadline) &&
            !labels.has("parked") &&
            ((labels.has("active") && !labels.has("blocked")) ||
              mustStart ||
              missingLead);
          const waiting = labels.has("waiting") || labels.has("blocked");
          const name = JSON.stringify(item);
          expect(deadlineRows([item], TODAY).length > 0, name).toBe(deadlines);
          expect(oldestUntouched([item], WAITING_LABELS).length > 0, name).toBe(
            waiting,
          );
        }
});

it("hides legacy key suffixes with spaces in Plus's own views", () => {
  expect(displayedTitle("Quarterly report <k:report dep:draft,data>")).toBe(
    "Quarterly report",
  );
  expect(displayedTitle("Draft <k:draft>")).toBe("Draft");
  expect(displayedTitle("<k:only>")).toBe("<k:only>");
});
