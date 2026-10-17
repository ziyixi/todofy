import { expect, it } from "vitest";
import { createPrototype } from "../design/fixture";
import {
  applyConfirmed,
  moved,
  predictChildOrder,
  predictLaneOrder,
  rereadsAfter,
  withNextWeek,
  withStage,
} from "../src/plan-updates";
import type { Stage } from "../src/model";

it("merges confirmed flows, tasks, Bets, plan settings and timer without a re-read", async () => {
  const data = await createPrototype().load();
  const today = data.focus.date;
  const flows = applyConfirmed(data, [
    { date: today, taskIds: ["outline"], completedTaskIds: [] },
    { date: "2026-10-14", taskIds: [], completedTaskIds: [] },
  ]);
  expect(flows.focus.taskIds).toEqual(["outline"]);
  expect(flows.days.find((day) => day.date === "2026-10-14")?.taskIds).toEqual(
    [],
  );
  expect(flows.plan).toBe(data.plan);

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

  const { tasks: shown, ...metadata } = data.plan;
  const labels = applyConfirmed(data, { ...metadata, etag: "plan-2" });
  expect(labels.plan.etag).toBe("plan-2");
  expect(labels.plan.tasks).toBe(shown);

  const timer = applyConfirmed(data, { timerEtag: "timer-2" });
  expect(timer.focus.timerEtag).toBe("timer-2");
  expect(timer.focus.timer).toBeUndefined();
  expect(applyConfirmed(data, undefined)).toBe(data);
  expect(applyConfirmed(data, [])).toEqual(data);
});

it("re-reads only after void results and label mapping changes", async () => {
  const data = await createPrototype().load();
  const { tasks, ...metadata } = data.plan;
  expect(rereadsAfter(undefined)).toBe(true);
  expect(rereadsAfter(metadata)).toBe(true);
  expect(rereadsAfter(tasks[0]!)).toBe(false);
  expect(rereadsAfter([tasks[0]!])).toBe(false);
  expect(rereadsAfter([data.days[0]!])).toBe(false);
  expect(rereadsAfter({ timerEtag: "1" })).toBe(false);
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

it("drops the mail tasks a confirmed deletion removed, and only those, without a re-read", async () => {
  const data = await createPrototype().load();
  const deletion = {
    deletedTaskIds: ["mail-register"],
    keptTaskIds: ["mail-notes"],
  };
  const after = applyConfirmed(data, deletion);
  const ids = after.plan.tasks.map((task) => task.id);
  expect(ids).not.toContain("mail-register");
  expect(ids).toContain("mail-notes");
  expect(ids).toHaveLength(data.plan.tasks.length - 1);
  expect(after.plan.weeklyBets).toBe(data.plan.weeklyBets);
  expect(rereadsAfter(deletion)).toBe(false);
});

it("merges a confirmed reorder's Todoist positions and the lane's saved order, and nothing else", async () => {
  const data = await createPrototype().load();
  const before = (id: string) =>
    data.plan.tasks.find((task) => task.id === id)!;
  const planned = {
    ...data,
    plan: { ...data.plan, laneOrders: { weekly: ["copy", "tools"] } },
  };
  // Todoist's answer carries no FlowDay estimate and a stale title; only the order fields count.
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

it("predicts setting a task aside, and back, with the labels Todofy's plan_labels writes", async () => {
  const data = await createPrototype().load();
  const predicted = (labels: string[], stage: Stage, parked: boolean) => {
    const plan = {
      ...data.plan,
      tasks: [{ ...data.plan.tasks[0]!, labels }],
    };
    const [task] = withStage(
      plan,
      plan.tasks[0]!.id,
      stage,
      false,
      parked,
    ).tasks;
    return { labels: [...task!.labels].sort(), stage: task!.stage };
  };
  // The cases of todofy/tests/unit/test_plus.py, with the fixture's names: parked wins over every
  // planning label, in progress and a stage sent with it, also where Quick makes focus or candiate
  // no stage at all.
  const full = ["committed", "quarter", "focus", "active", "office", "deep"];
  expect(predicted(full, "none", true)).toEqual({
    labels: ["deep", "office", "parked"],
    stage: "none",
  });
  for (const planning of ["focus", "candiate"])
    expect(predicted(["quick", planning], "none", true).labels).toEqual([
      "parked",
      "quick",
    ]);
  expect(predicted(["office"], "committed", true)).toEqual({
    labels: ["office", "parked"],
    stage: "none",
  });
  // Out of Parked into a stage lane: the stage's label, and parked goes.
  expect(predicted(["parked", "office"], "monthly", false)).toEqual({
    labels: ["candiate", "office"],
    stage: "monthly",
  });
  expect(
    predicted(["parked", "deep", "waiting"], "weekly", false).labels,
  ).toEqual(["deep", "focus", "waiting"]);
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
