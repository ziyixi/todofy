import { afterEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import {
  TimerSessionSchema,
  TimerSession_State,
} from "@ziyixi/proto/flowday/ui/v1/time_entry_pb";
import { FlowSchema } from "@ziyixi/proto/flowday/ui/v1/flow_pb";
import { CompleteTaskResponseSchema } from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import { api } from "./api";
import { planningApi } from "./task-planning";
import {
  completionFocusApi,
  settleCompletedTask,
} from "./task-completion-focus";

afterEach(() => vi.restoreAllMocks());
const parent = create(TaskSchema, {
  id: "parent",
  name: "tasks/parent",
  title: "Synthetic outcome",
  etag: "1",
});
const id = "f4d27023-1d96-4bd0-a1b8-e8366646d236";
it("settles a completed descendant's running timer on its original flow day using the same completion proof", async () => {
  vi.spyOn(completionFocusApi, "getTimerSession").mockResolvedValue(
    create(TimerSessionSchema, {
      state: TimerSession_State.RUNNING,
      taskId: "step",
      flowDate: "2026-10-16",
      etag: "timer",
    }),
  );
  vi.spyOn(api, "getTask").mockResolvedValue(
    create(TaskSchema, {
      id: "step",
      name: "tasks/step",
      parentId: parent.id,
      completed: true,
    }),
  );
  const settle = vi
    .spyOn(planningApi, "completeTask")
    .mockResolvedValue(
      create(CompleteTaskResponseSchema, { taskId: parent.id }),
    );
  expect(
    await settleCompletedTask(parent, id, "1", "2026-10-17"),
  ).toBeUndefined();
  expect(settle).toHaveBeenCalledWith({
    taskId: parent.id,
    requestId: id,
    taskEtag: "1",
    flowTaskId: "step",
    flowDate: "2026-10-16",
  });
});
it("leaves an unrelated timer running and does not add an unplanned task to a flow", async () => {
  vi.spyOn(completionFocusApi, "getTimerSession").mockResolvedValue(
    create(TimerSessionSchema, {
      state: TimerSession_State.RUNNING,
      taskId: "unrelated",
      flowDate: "2026-10-17",
      etag: "timer",
    }),
  );
  vi.spyOn(api, "getTask").mockResolvedValue(
    create(TaskSchema, {
      id: "unrelated",
      name: "tasks/unrelated",
      completed: false,
    }),
  );
  vi.spyOn(completionFocusApi, "getFlow").mockResolvedValue(
    create(FlowSchema, { name: "flows/2026-10-17", taskIds: ["unrelated"] }),
  );
  const settle = vi.spyOn(planningApi, "completeTask");
  expect(
    await settleCompletedTask(parent, id, "1", "2026-10-17"),
  ).toBeUndefined();
  expect(settle).not.toHaveBeenCalled();
});
it("settles an already planned task without needing an active timer", async () => {
  vi.spyOn(completionFocusApi, "getTimerSession").mockResolvedValue(
    create(TimerSessionSchema, { etag: "0" }),
  );
  vi.spyOn(completionFocusApi, "getFlow").mockResolvedValue(
    create(FlowSchema, { name: "flows/2026-10-17", taskIds: [parent.id] }),
  );
  const settle = vi
    .spyOn(planningApi, "completeTask")
    .mockResolvedValue(
      create(CompleteTaskResponseSchema, { taskId: parent.id }),
    );
  expect(
    await settleCompletedTask(parent, id, "1", "2026-10-17"),
  ).toBeUndefined();
  expect(settle).toHaveBeenCalledWith(
    expect.objectContaining({ flowTaskId: parent.id, flowDate: "2026-10-17" }),
  );
});
it("reports Focus unavailability after the independent generic completion", async () => {
  vi.spyOn(completionFocusApi, "getTimerSession").mockRejectedValue(
    new TypeError("Synthetic Focus outage"),
  );
  expect(await settleCompletedTask(parent, id, "1", "2026-10-17")).toMatch(
    /^Task completed\. Focus/,
  );
});
