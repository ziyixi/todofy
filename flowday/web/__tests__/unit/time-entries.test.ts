import { describe, expect, it } from "vitest";
import {
  mapEntrySecondsByTask,
  sumEntryDurationSeconds,
} from "@/lib/utils/time-entries";

describe("time entry helpers", () => {
  it("sums nullable durations", () => {
    expect(
      sumEntryDurationSeconds([
        { durationS: 90 },
        { durationS: null },
        {},
        { durationS: 30 },
      ])
    ).toBe(120);
  });

  it("groups durations by task id", () => {
    expect(
      mapEntrySecondsByTask([
        { taskId: "task-1", durationS: 60 },
        { taskId: "task-2", durationS: 30 },
        { taskId: "task-1", durationS: null },
        { taskId: "task-1", durationS: 15 },
      ])
    ).toEqual({
      "task-1": 75,
      "task-2": 30,
    });
  });
});
