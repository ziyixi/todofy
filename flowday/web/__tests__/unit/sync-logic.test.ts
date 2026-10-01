import { describe, it, expect } from "vitest";
import {
  getAllTasks,
  getDeletedTasks,
  softDeleteTask,
  upsertTasks,
} from "@/lib/db/queries/tasks";
import { partitionTasksByDueDate } from "@/lib/utils/task-sections";
import type { Task } from "@/lib/types/task";

/**
 * Unit tests for sync-related DB behaviour.
 *
 * These tests verify that upsertTasks correctly updates dueDate for
 * tasks that are rescheduled in Todoist, and that the task-section
 * filtering logic (today / overdue / future) categorises correctly.
 */

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? "t1",
    todoistId: overrides.todoistId ?? "todoist-1",
    title: "Todoist Task",
    description: null,
    projectName: null,
    projectColor: null,
    priority: 1,
    labels: [],
    estimatedMins: null,
    isCompleted: false,
    completedAt: null,
    dueDate: null,
    createdAt: "2026-04-10T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  } as Task;
}

describe("upsertTasks — dueDate updates", () => {
  it("updates dueDate when a task is rescheduled", () => {
    // Initial sync: task due today
    upsertTasks([makeTask({ id: "t1", dueDate: "2026-04-16" })]);
    expect(getAllTasks()[0].dueDate).toBe("2026-04-16");

    // Second sync: task rescheduled to next week
    upsertTasks([makeTask({ id: "t1", dueDate: "2026-04-23" })]);
    const tasks = getAllTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].dueDate).toBe("2026-04-23");
  });

  it("clears dueDate when Todoist removes it", () => {
    upsertTasks([makeTask({ id: "t1", dueDate: "2026-04-16" })]);
    upsertTasks([makeTask({ id: "t1", dueDate: null })]);
    expect(getAllTasks()[0].dueDate).toBeNull();
  });

  it("preserves local estimate when Todoist has no duration", () => {
    // Task with local estimate
    upsertTasks([makeTask({ id: "t1", estimatedMins: 45 })]);
    expect(getAllTasks()[0].estimatedMins).toBe(45);

    // Todoist sync with no duration — local estimate preserved
    upsertTasks([makeTask({ id: "t1", estimatedMins: null })]);
    expect(getAllTasks()[0].estimatedMins).toBe(45);
  });

  it("overwrites local estimate when Todoist provides one", () => {
    upsertTasks([makeTask({ id: "t1", estimatedMins: 45 })]);

    // Todoist now has a duration
    upsertTasks([makeTask({ id: "t1", estimatedMins: 60 })]);
    expect(getAllTasks()[0].estimatedMins).toBe(60);
  });

  it("marks task completed when Todoist reports it", () => {
    upsertTasks([makeTask({ id: "t1", isCompleted: false })]);
    upsertTasks([makeTask({ id: "t1", isCompleted: true, completedAt: "2026-04-16T10:00:00Z" })]);
    const task = getAllTasks()[0];
    expect(task.isCompleted).toBe(true);
    expect(task.completedAt).toBe("2026-04-16T10:00:00Z");
  });

  it("preserves soft-delete status across syncs", () => {
    upsertTasks([makeTask({ id: "t1", dueDate: "2026-04-16" })]);

    // Soft-delete locally
    softDeleteTask("t1");

    // Sync again — task should stay deleted
    upsertTasks([makeTask({ id: "t1", dueDate: "2026-04-16" })]);
    expect(getDeletedTasks()).toHaveLength(1);
  });
});

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
