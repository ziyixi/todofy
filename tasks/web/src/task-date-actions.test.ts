import { afterEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import { PreviewDateResponseSchema } from "@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb";
import {
  ListPlanningTasksResponseSchema,
  SetTaskLeadResponseSchema,
} from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import { api } from "./api";
import { planningApi } from "./task-planning";
import { clearTaskStartAhead, taskScheduleFromText } from "./task-date-actions";

afterEach(() => vi.restoreAllMocks());

it("uses a calendar date for normal task input and retains explicit step time", async () => {
  vi.spyOn(api, "previewDate").mockResolvedValue(
    create(PreviewDateResponseSchema, {
      dueDate: "2030-01-02",
      dueDatetime: "2030-01-02T17:00:00.000Z",
      dueTimezone: "America/Los_Angeles",
      recurrence: "every day",
    }),
  );
  const task = create(TaskSchema, { id: "synthetic", kind: "task" });
  expect(
    await taskScheduleFromText(task, "tomorrow at 9", "America/Los_Angeles"),
  ).toEqual({
    values: {
      dueDate: "2030-01-02",
      dueDatetime: "",
      dueTimezone: "",
      recurrence: "every day",
    },
    ignoredClock: true,
  });
  expect(
    await taskScheduleFromText(
      create(TaskSchema, { ...task, kind: "step" }),
      "tomorrow at 9",
      "America/Los_Angeles",
    ),
  ).toEqual({
    values: {
      dueDate: "2030-01-02",
      dueDatetime: "2030-01-02T17:00:00.000Z",
      dueTimezone: "America/Los_Angeles",
      recurrence: "every day",
    },
    ignoredClock: false,
  });
});

it("clears only the current native lead after the generic deadline is empty", async () => {
  vi.spyOn(planningApi, "listPlanningTasks").mockResolvedValue(
    create(ListPlanningTasksResponseSchema, {
      planningTasks: [
        { id: "synthetic", deadline: "", leadDays: 14, etag: "fresh-planning" },
      ],
    }),
  );
  const save = vi
    .spyOn(planningApi, "setTaskLead")
    .mockResolvedValue(create(SetTaskLeadResponseSchema));
  await clearTaskStartAhead("synthetic");
  expect(save).toHaveBeenCalledWith({
    taskId: "synthetic",
    etag: "fresh-planning",
    requestId: expect.any(String),
    deadline: "",
    leadDays: 0,
  });
});

it("does not overwrite a deadline changed elsewhere while its lead was being cleared", async () => {
  vi.spyOn(planningApi, "listPlanningTasks").mockResolvedValue(
    create(ListPlanningTasksResponseSchema, {
      planningTasks: [
        {
          id: "synthetic",
          deadline: "2030-01-20",
          leadDays: 14,
          etag: "newer-planning",
        },
      ],
    }),
  );
  const save = vi.spyOn(planningApi, "setTaskLead");
  await expect(clearTaskStartAhead("synthetic")).rejects.toThrow(
    "deadline changed",
  );
  expect(save).not.toHaveBeenCalled();
});
