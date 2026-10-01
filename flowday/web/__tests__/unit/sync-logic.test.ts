import { describe, it, expect } from "vitest";
import { partitionTasksByDueDate } from "@/lib/utils/task-sections";

/**
 * The task-section filtering (today / overdue / future) the sidebar applies to synced tasks. The sync's own
 * upsert rules (reschedules, estimates, completion, soft deletes) are tested on D1 in
 * worker/test/runtime/store.test.ts and sync.test.ts.
 */

describe("task section categorisation", () => {
  it("puts task due today in today", () => {
    const result = partitionTasksByDueDate([{ dueDate: "2026-04-16" }], "2026-04-16");
    expect(result.dueOnDate).toHaveLength(1);
    expect(result.overdue).toHaveLength(0);
  });

  it("puts task due yesterday in overdue", () => {
    const result = partitionTasksByDueDate([{ dueDate: "2026-04-15" }], "2026-04-16");
    expect(result.dueOnDate).toHaveLength(0);
    expect(result.overdue).toHaveLength(1);
  });

  it("skips future-dated tasks", () => {
    const result = partitionTasksByDueDate([{ dueDate: "2026-04-20" }], "2026-04-16");
    expect(result.dueOnDate).toHaveLength(0);
    expect(result.overdue).toHaveLength(0);
  });

  it("hides tasks with no dueDate", () => {
    const result = partitionTasksByDueDate([{ dueDate: null }], "2026-04-16");
    expect(result.dueOnDate).toHaveLength(0);
    expect(result.overdue).toHaveLength(0);
  });

  it("correctly splits mixed tasks", () => {
    const tasks = [
      { dueDate: "2026-04-14" }, // overdue
      { dueDate: "2026-04-16" }, // today
      { dueDate: "2026-04-20" }, // future — skipped
      { dueDate: null },          // no date — skipped
    ];
    const result = partitionTasksByDueDate(tasks, "2026-04-16");
    expect(result.overdue).toHaveLength(1);
    expect(result.dueOnDate).toHaveLength(1);
  });

  it("uses the selected future planning date as the anchor", () => {
    const tasks = [
      { dueDate: "2026-04-18" }, // selected date
      { dueDate: "2026-04-17" }, // overdue relative to selected date
      { dueDate: "2026-04-19" }, // still future
    ];
    const result = partitionTasksByDueDate(tasks, "2026-04-18");
    expect(result.dueOnDate).toHaveLength(1);
    expect(result.overdue).toHaveLength(1);
  });
});
