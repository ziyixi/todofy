import { expect, it } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import {
  GtdReportSchema,
  GtdTaskProgressSchema,
} from "@ziyixi/proto/tasks/ui/v1/gtd_pb";
import {
  areaLabel,
  completedDayLabel,
  dateRangeLabel,
  loggedTime,
  percentage,
  progressGroups,
  reportRange,
} from "./model";

it("computes week and month reportRange bounds and formats dateRangeLabel across months and years", () => {
  expect(reportRange("week", "2030-04-17")).toEqual([
    "2030-04-14",
    "2030-04-20",
  ]);
  expect(reportRange("month", "2030-02-15")).toEqual([
    "2030-02-01",
    "2030-02-28",
  ]);

  expect(dateRangeLabel("2030-04-01", "2030-04-30", "month")).toBe(
    "April 2030",
  );
  expect(dateRangeLabel("2030-04-15", "2030-04-21", "week")).toBe(
    "Apr 15 – 21, 2030",
  );
  expect(dateRangeLabel("2030-04-29", "2030-05-05", "week")).toBe(
    "Apr 29 – May 5, 2030",
  );
  expect(dateRangeLabel("2029-12-31", "2030-01-06", "week")).toBe(
    "Dec 31, 2029 – Jan 6, 2030",
  );
});

it("formats loggedTime, percentage, areaLabel, and completedDayLabel", () => {
  expect(loggedTime(150)).toBe("2m");
  expect(loggedTime(3600)).toBe("1h");
  expect(percentage(0, 0)).toBe(0);
  expect(percentage(3, 4)).toBe(75);

  expect(areaLabel("work")).toBe("Work");
  expect(areaLabel("personal")).toBe("Personal");
  expect(areaLabel("unassigned")).toBe("No area");

  expect(completedDayLabel("", "2030-04-15")).toBe("Not completed");
  expect(completedDayLabel("2030-04-15", "2030-04-20")).toContain("Apr 15");
  expect(completedDayLabel("2030-04-15", "2030-04-20")).not.toContain("2030");
  expect(completedDayLabel("2029-12-31", "2030-04-20")).toContain("2029");
});

it("groups tasks and steps by parent, keeps orphan steps visible, and sorts completed tasks first", () => {
  const report = create(GtdReportSchema, {
    tasks: [
      create(GtdTaskProgressSchema, {
        taskId: "task-open",
        title: "Beta open task",
        kind: "task",
        planned: true,
        completed: false,
        routine: false,
      }),
      create(GtdTaskProgressSchema, {
        taskId: "task-done",
        title: "Zulu completed task",
        kind: "task",
        planned: true,
        completed: true,
        completionCount: 1,
        routine: false,
      }),
      create(GtdTaskProgressSchema, {
        taskId: "step-under-open",
        parentId: "task-open",
        parentTitle: "Beta open task",
        title: "Step 1",
        kind: "step",
        planned: true,
        routine: false,
      }),
      create(GtdTaskProgressSchema, {
        taskId: "step-orphan",
        parentId: "task-unplanned-parent",
        parentTitle: "Alpha parent task",
        title: "Step under unplanned parent",
        kind: "step",
        completionCount: 1,
        routine: false,
      }),
      create(GtdTaskProgressSchema, {
        taskId: "routine-1",
        title: "Morning review",
        kind: "task",
        planned: true,
        completed: true,
        routine: true,
      }),
    ],
  });

  const nonRoutine = progressGroups(report, false);
  expect(nonRoutine.map((g) => g.id)).toEqual([
    "task-done",
    "task-unplanned-parent",
    "task-open",
  ]);
  expect(nonRoutine[1]?.title).toBe("Alpha parent task");
  expect(nonRoutine[1]?.steps).toHaveLength(1);
  expect(nonRoutine[2]?.steps.map((s) => s.taskId)).toEqual(["step-under-open"]);

  const routines = progressGroups(report, true);
  expect(routines.map((g) => g.id)).toEqual(["routine-1"]);
});
