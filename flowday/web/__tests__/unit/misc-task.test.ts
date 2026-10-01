import { describe, expect, it } from "vitest";
import {
  buildMiscTask,
  buildMiscTaskId,
  buildMiscTaskTitle,
  getMiscTaskDate,
  isMiscTaskId,
  MISC_TASK_PROJECT_NAME,
} from "@/lib/utils/misc-task";

describe("misc task helpers", () => {
  it("builds and recognizes daily sentinel ids", () => {
    const taskId = buildMiscTaskId("2026-04-21");
    expect(taskId).toBe("__flowday_misc__:2026-04-21");
    expect(isMiscTaskId(taskId)).toBe(true);
    expect(getMiscTaskDate(taskId)).toBe("2026-04-21");
  });

  it("builds a synthetic task view for misc ids", () => {
    const task = buildMiscTask(buildMiscTaskId("2026-04-21"));
    expect(task).toMatchObject({
      id: "__flowday_misc__:2026-04-21",
      title: buildMiscTaskTitle("2026-04-21"),
      projectName: MISC_TASK_PROJECT_NAME,
      dueDate: "2026-04-21",
    });
  });

  it("rejects malformed ids", () => {
    expect(isMiscTaskId("task-1")).toBe(false);
    expect(getMiscTaskDate("__flowday_misc__:bad")).toBeNull();
    expect(buildMiscTask("__flowday_misc__:bad")).toBeNull();
  });
});
