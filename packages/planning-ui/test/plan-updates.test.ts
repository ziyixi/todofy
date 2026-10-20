import { expect, it } from "vitest";
import { createPrototype } from "./fixture";
import {
  applyConfirmed,
  moved,
  predictChildOrder,
  predictEstimate,
  predictLaneOrder,
  rereadsAfter,
  withNextWeek,
  withStage,
} from "../src/plan-updates";
import type { FocusEntry, Stage } from "../src/model";

it("merges confirmed queues, tasks, Bets, plan settings and timer without a re-read", async () => {
  const data = await createPrototype().load();
  const today = data.focus.date;
  const queues = applyConfirmed(data, [
    { date: today, taskIds: ["outline"], completedTaskIds: [] },
    { date: "2026-10-14", taskIds: [], completedTaskIds: [] },
  ]);
  expect(queues.focus.taskIds).toEqual(["outline"]);
  expect(queues.days.find((day) => day.date === "2026-10-14")?.taskIds).toEqual(
    [],
  );
  expect(queues.plan).toBe(data.plan);

  const copy = data.plan.tasks.find((task) => task.id === "copy")!;
  const release = data.plan.tasks.find((task) => task.id === "release")!;
  const tasks = applyConfirmed(data, [
    { ...copy, etag: "copy-2" },
    { ...release, stage: "weekly", etag: "release-2" },
  ]);
  expect(tasks.plan.tasks.find((task) => task.id === "copy")?.etag).toBe(
    "copy-2",
  );
  expect(tasks.plan.tasks.find((task) => task.id === "release")?.stage).toBe(
    "weekly",
  );
  expect(tasks.plan.tasks).toHaveLength(data.plan.tasks.length);

  // A saved Bet replaces the one of its week and area; a new one joins them.
  const work = {
    weekStart: "2026-10-12",
    area: "work" as const,
    text: "Saved elsewhere",
    etag: "3",
  };
  const next = { ...work, weekStart: "2026-10-19", etag: "1" };
  const bets = applyConfirmed(data, work);
  expect(bets.plan.weeklyBets).toHaveLength(2);
  expect(bets.plan.weeklyBets).toContainEqual(work);
  expect(applyConfirmed(bets, [next, work]).plan.weeklyBets).toEqual([
    data.plan.weeklyBets.find((bet) => bet.area === "personal"),
    next,
    work,
  ]);
  expect(bets.plan.tasks).toBe(data.plan.tasks);
  expect(applyConfirmed(data, []).plan).toBe(data.plan);
  expect(rereadsAfter(work)).toBe(false);
  expect(rereadsAfter([])).toBe(false);

  const lead = applyConfirmed(data, { ...copy, deadline: "2026-10-30" });
  expect(lead.plan.tasks.find((task) => task.id === "copy")?.deadline).toBe(
    "2026-10-30",
  );

  const timer = applyConfirmed(data, { timerEtag: "timer-2" });
  expect(timer.focus.timerEtag).toBe("timer-2");
  expect(timer.focus.timer).toBeUndefined();
  expect(applyConfirmed(data, undefined)).toBe(data);
  expect(applyConfirmed(data, [])).toEqual(data);
});

it("replaces a day's queue and keeps its records, and merges a saved, deleted or timer record", async () => {
  const data = await createPrototype().load();
  const today = data.focus.date;
  const record = (id: string, seconds: number, date = today): FocusEntry => ({
    id,
    taskId: "copy",
    date,
    seconds,
    source: "manual",
    area: "work",
    etag: "1",
  });
  const day = (date: string) => data.days.find((item) => item.date === date)!;
  day(today).entries = [record("first", 600)];
  data.focus.entries = [record("first", 600)];

  // A queue answer has no records; the day's stay.
  const queued = applyConfirmed(data, [
    { date: today, taskIds: ["outline"], completedTaskIds: ["copy"] },
  ]);
  expect(queued.focus.entries).toEqual([record("first", 600)]);
  expect(queued.focus.completedTaskIds).toEqual(["copy"]);
  expect(queued.days.find((item) => item.date === today)?.entries).toEqual([
    record("first", 600),
  ]);

  // A saved record replaces its old self in place, or joins its day; only that day changes.
  const changed = applyConfirmed(queued, {
    savedEntry: { ...record("first", 2400), etag: "2" },
  });
  expect(changed.focus.entries).toEqual([
    { ...record("first", 2400), etag: "2" },
  ]);
  const added = applyConfirmed(changed, {
    savedEntry: record("yesterday", 900, "2026-10-12"),
  });
  expect(
    added.days.find((item) => item.date === "2026-10-12")?.entries,
  ).toEqual([record("yesterday", 900, "2026-10-12")]);
  expect(added.focus).toBe(changed.focus);
  expect(rereadsAfter({ savedEntry: record("first", 60) })).toBe(false);

  // A stopped session's record joins today with the idle timer.
  const stopped = applyConfirmed(added, {
    timerEtag: "timer-3",
    entry: { ...record("session", 1500), source: "timer" },
  });
  expect(stopped.focus.timerEtag).toBe("timer-3");
  expect(stopped.focus.entries.map((entry) => entry.id)).toEqual([
    "first",
    "session",
  ]);
  expect(
    stopped.days
      .find((item) => item.date === today)
      ?.entries.map((entry) => entry.id),
  ).toEqual(["first", "session"]);

  const deleted = applyConfirmed(stopped, {
    deletedEntry: { id: "first", date: today },
  });
  expect(deleted.focus.entries.map((entry) => entry.id)).toEqual(["session"]);
  expect(rereadsAfter({ deletedEntry: { id: "first", date: today } })).toBe(
    false,
  );
});

it("re-reads only after void results", async () => {
  const data = await createPrototype().load();
  const { tasks } = data.plan;
  expect(rereadsAfter(undefined)).toBe(true);
  expect(rereadsAfter(tasks[0]!)).toBe(false);
  expect(rereadsAfter([tasks[0]!])).toBe(false);
  expect(rereadsAfter([data.days[0]!])).toBe(false);
  expect(rereadsAfter({ timerEtag: "1" })).toBe(false);
  expect(rereadsAfter({ estimate: { taskId: "copy", minutes: 60 } })).toBe(
    false,
  );
});

it("shows a saved estimate as its prediction did, and 0 as none", async () => {
  const data = await createPrototype().load();
  const minutes = (shown: typeof data) => [
    shown.plan.tasks.find((task) => task.id === "copy")?.estimatedMinutes,
    shown.focus.estimates.copy,
  ];
  const predicted = predictEstimate("copy", 60)(data);
  const saved = applyConfirmed(data, {
    estimate: { taskId: "copy", minutes: 60 },
  });
  expect(minutes(predicted)).toEqual([60, 60]);
  expect(saved).toEqual(predicted);
  // Every other task, the queues and the plan's settings stay as they were.
  expect(saved.plan.tasks.filter((task) => task.id !== "copy")).toEqual(
    data.plan.tasks.filter((task) => task.id !== "copy"),
  );
  expect(saved.days).toBe(data.days);
  expect(
    minutes(
      applyConfirmed(saved, { estimate: { taskId: "copy", minutes: 0 } }),
    ),
  ).toEqual([undefined, 0]);
});

it("mirrors Sunday's next-week choices from confirmed planning writes until the next read", async () => {
  const sunday = await createPrototype(false, "2026-10-18").load();
  const task = (id: string) =>
    sunday.plan.tasks.find((item) => item.id === id)!;
  const ids = (data: typeof sunday) => data.plan.nextWeekTaskIds;
  // A commitment chosen on the last day is kept; a write that leaves it uncommitted is not.
  const committed = { ...task("tools"), stage: "committed" as const };
  const kept = withNextWeek(sunday, { stage: "committed" }, committed);
  expect(ids(kept)).toEqual(["tools"]);
  const walk = { ...task("walk"), stage: "committed" as const };
  const both = withNextWeek(kept, { stage: "committed" }, walk);
  expect(ids(both)).toEqual(["tools", "walk"]);
  expect(ids(withNextWeek(both, { stage: "weekly" }, task("walk")))).toEqual([
    "tools",
  ]);
  // Another change to a kept task leaves it kept while committed; one to another task does not keep it.
  expect(ids(withNextWeek(both, { area: "personal" }, committed))).toEqual([
    "walk",
    "tools",
  ]);
  expect(ids(withNextWeek(sunday, {}, task("notes")))).toEqual([]);
  // Any other day changes nothing.
  const tuesday = await createPrototype().load();
  expect(withNextWeek(tuesday, { stage: "committed" }, committed)).toBe(
    tuesday,
  );
});

it("merges a confirmed reorder's Todoist positions and the lane's saved order, and nothing else", async () => {
  const data = await createPrototype().load();
  const before = (id: string) =>
    data.plan.tasks.find((task) => task.id === id)!;
  const planned = {
    ...data,
    plan: { ...data.plan, laneOrders: { weekly: ["copy", "tools"] } },
  };
  // The answer carries no estimate and a stale title; only the order fields count.
  const after = applyConfirmed(planned, {
    reordered: [
      {
        ...before("layout"),
        title: "Not merged",
        estimatedMinutes: undefined,
        childOrder: 1,
        orderKey: "a0",
        updatedAt: "2026-10-13T08:00:00.000Z",
      },
      { ...before("copy"), childOrder: 2 },
    ],
    lane: { lane: "committed", taskIds: ["layout", "copy"] },
  });
  const task = (id: string) => after.plan.tasks.find((item) => item.id === id)!;
  expect(task("layout")).toEqual({
    ...before("layout"),
    childOrder: 1,
    orderKey: "a0",
    updatedAt: "2026-10-13T08:00:00.000Z",
  });
  expect(task("copy")).toEqual({ ...before("copy"), childOrder: 2 });
  // As Todofy saves it, the lane's tasks leave every other lane's order.
  expect(after.plan.laneOrders).toEqual({
    weekly: ["tools"],
    committed: ["layout", "copy"],
  });
  expect(after.days).toBe(data.days);
  expect(rereadsAfter({ reordered: [] })).toBe(false);
  // Only Todoist's order: no lane is saved, and a lane left empty goes.
  const unlaned = applyConfirmed(planned, { reordered: [] });
  expect(unlaned.plan.laneOrders).toBe(planned.plan.laneOrders);
  expect(
    applyConfirmed(planned, {
      reordered: [],
      lane: { lane: "weekly", taskIds: [] },
    }).plan.laneOrders,
  ).toEqual({});
  // A dependency result is not a reorder.
  expect(
    applyConfirmed(planned, { forTask: "copy", dependencies: [] }).plan
      .laneOrders,
  ).toBe(planned.plan.laneOrders);
});

it("moves an item as a sortable list does, and predicts a lane's order as Todofy saves it", async () => {
  const ids = ["a", "b", "c", "d"];
  // Down, the item lands after the one it was dropped on; up, before it.
  expect(moved(ids, 0, 2)).toEqual(["b", "c", "a", "d"]);
  expect(moved(ids, 3, 1)).toEqual(["a", "d", "b", "c"]);
  expect(moved(ids, 3, 3)).toEqual(ids);
  expect(ids).toEqual(["a", "b", "c", "d"]);
  const data = await createPrototype().load();
  const planned = {
    ...data,
    plan: {
      ...data.plan,
      laneOrders: { weekly: ["tools", "walk"], committed: ["desk"] },
    },
  };
  const predicted = predictLaneOrder("monthly", ["walk", "reading"])(planned);
  expect(predicted.plan.laneOrders).toEqual({
    weekly: ["tools"],
    committed: ["desk"],
    monthly: ["walk", "reading"],
  });
  expect(predicted.plan.tasks).toBe(planned.plan.tasks);
});

it("predicts a reorder of siblings with their own positions and keys, or not at all", async () => {
  const data = await createPrototype().load();
  const base = data.plan.tasks.find((task) => task.id === "copy")!;
  const sibling = (id: string, childOrder?: number, orderKey?: string) => ({
    ...base,
    id,
    childOrder,
    orderKey,
  });
  const withTasks = (tasks: (typeof base)[]) => ({
    ...data,
    plan: { ...data.plan, tasks },
  });
  const tasks = [
    sibling("a", 1, "a1"),
    sibling("b", 5, "a3"),
    sibling("c", 3, "a2"),
  ];
  const predict = predictChildOrder(tasks, ["c", "a", "b"])!;
  expect(
    predict(withTasks(tasks)).plan.tasks.map(({ id, childOrder, orderKey }) => [
      id,
      childOrder,
      orderKey,
    ]),
  ).toEqual([
    ["a", 3, "a2"],
    ["b", 5, "a3"],
    ["c", 1, "a1"],
  ]);
  // Without every key, only the positions move.
  const unkeyed = [sibling("a", 1, "a1"), sibling("b", 2)];
  expect(
    predictChildOrder(unkeyed, ["b", "a"])!(withTasks(unkeyed)).plan.tasks.map(
      ({ childOrder, orderKey }) => [childOrder, orderKey],
    ),
  ).toEqual([
    [2, "a1"],
    [1, undefined],
  ]);
  // A missing or repeated position is written by no one.
  expect(
    predictChildOrder([sibling("a", 1), sibling("b")], ["b", "a"]),
  ).toBeUndefined();
  expect(
    predictChildOrder([sibling("a", 2), sibling("b", 2)], ["b", "a"]),
  ).toBeUndefined();
});
