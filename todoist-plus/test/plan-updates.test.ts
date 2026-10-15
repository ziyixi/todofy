import { expect, it } from "vitest";
import { createPrototype } from "../design/fixture";
import { applyConfirmed, rereadsAfter } from "../src/plan-updates";

it("merges confirmed flows, tasks, plan settings and timer without a re-read", async () => {
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
    { ...copy, bet: true, etag: "copy-2" },
    { ...release, bet: false, etag: "release-2" },
  ]);
  expect(tasks.plan.tasks.find((task) => task.id === "copy")?.etag).toBe(
    "copy-2",
  );
  expect(tasks.plan.tasks.find((task) => task.id === "release")?.bet).toBe(
    false,
  );
  expect(tasks.plan.tasks).toHaveLength(data.plan.tasks.length);

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
