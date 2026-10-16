import { expect, it } from "vitest";
import { createPrototype } from "../design/fixture";
import {
  applyConfirmed,
  rereadsAfter,
  withNextWeek,
} from "../src/plan-updates";

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
