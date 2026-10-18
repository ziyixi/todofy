import { createHttpClient, RpcStatusError } from "@ziyixi/proto/http-client";
import { FlowDayUiService } from "@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb";
import { TimerSession_State } from "@ziyixi/proto/flowday/ui/v1/time_entry_pb";
import { api, send, type Task } from "./api";
import { planningApi } from "./task-planning";

export const completionFocusApi = createHttpClient(FlowDayUiService, (call) =>
  send({ ...call, url: `/api/plus/flowday${call.url}` }),
);
const WARNING =
  "Task completed. Focus could not confirm the timer or day queue. Open Focus, refresh, and stop any timer still running for this task.";

/** The generic task is already saved. Focus failures must never repeat or undo its completion. */
export async function settleCompletedTask(
  task: Task,
  requestId: string,
  taskEtag: string,
  today: string,
): Promise<string | undefined> {
  try {
    const timer = await completionFocusApi.getTimerSession({
      name: "timerSession",
    });
    let target = task.id;
    let date = today;
    let relatedTimer = false;
    if (
      timer.taskId &&
      (timer.state === TimerSession_State.RUNNING ||
        timer.state === TimerSession_State.PAUSED)
    ) {
      if (timer.taskId === task.id) relatedTimer = true;
      else {
        let child: Task | undefined;
        try {
          child = await api.getTask({ name: `tasks/${timer.taskId}` });
        } catch (error) {
          if (
            !(error instanceof RpcStatusError) ||
            error.status.httpStatus !== 404
          )
            throw error;
        }
        if (child?.completed) {
          const seen = new Set([child.id]);
          for (let depth = 0; depth < 32 && child.parentId; depth++) {
            if (child.parentId === task.id) {
              relatedTimer = true;
              break;
            }
            if (seen.has(child.parentId)) break;
            seen.add(child.parentId);
            child = await api.getTask({ name: `tasks/${child.parentId}` });
          }
        }
      }
      if (relatedTimer) {
        target = timer.taskId;
        date = timer.flowDate;
      }
    }
    if (!relatedTimer) {
      const day = await completionFocusApi.getFlow({ name: `flows/${today}` });
      if (!day.taskIds.includes(task.id)) return undefined;
    }
    await planningApi.completeTask({
      taskId: task.id,
      requestId,
      taskEtag,
      flowTaskId: target,
      flowDate: date,
    });
    return undefined;
  } catch {
    return WARNING;
  }
}
