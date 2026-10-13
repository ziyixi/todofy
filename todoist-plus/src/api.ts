import {
  createHttpClient,
  HttpResponseError,
  RpcStatusError,
} from "@ziyixi/proto/http-client";
import {
  PlusService,
  type PlanningTask as ApiPlanningTask,
} from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import {
  CommandTimerRequest_Action,
  FlowDayUiService,
  SyncTasksResponse_State,
} from "@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb";
import { TimerSession_State } from "@ziyixi/proto/flowday/ui/v1/time_entry_pb";
import type { FocusState, PlanningTask, PlusActions } from "./model";

export interface Connection {
  apiOrigin: string;
  token: string;
}
export function validOrigin(input: string): string {
  const url = new URL(input);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  )
    throw new Error("Enter an HTTPS origin, without a path.");
  return url.origin;
}
export function publicError(error: unknown): string {
  if (error instanceof RpcStatusError)
    return error.status.localizedMessage?.message ?? error.status.message;
  if (error instanceof HttpResponseError && error.httpStatus === 401)
    return "Connection expired or revoked. Open connection settings.";
  return "Could not confirm this operation. Refresh and try again.";
}
export function planningTask(task: ApiPlanningTask): PlanningTask {
  return {
    id: task.id,
    title: task.title,
    parentId: task.parentId,
    projectId: task.projectId,
    labels: task.labels,
    area: ["work", "personal"].includes(task.area)
      ? (task.area as PlanningTask["area"])
      : "unassigned",
    stage: ["monthly", "weekly", "committed"].includes(task.stage)
      ? (task.stage as PlanningTask["stage"])
      : "none",
    bet: task.bet,
    deadline: task.deadline,
    due: task.due,
    leadDays: task.leadDays,
    estimatedMinutes: task.estimatedMinutes,
    etag: task.etag,
    mustStart: task.mustStart,
    missingLead: task.missingLead,
  };
}
export function createApi(
  connection: Connection,
  fetcher: typeof fetch = fetch,
): PlusActions {
  const transport =
    (prefix: string) =>
    async (call: { url: string; httpMethod: string; body?: string }) => {
      const url = new URL(prefix + call.url, connection.apiOrigin);
      if (url.origin !== validOrigin(connection.apiOrigin))
        throw new Error("Invalid API origin");
      return fetcher(url, {
        method: call.httpMethod,
        body: call.body,
        credentials: "omit",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${connection.token}`,
          ...(call.body ? { "Content-Type": "application/json" } : {}),
        },
      });
    };
  const timerRequests = new Map<string, string>();
  let knownFlowTasks = new Set<string>();
  const plus = createHttpClient(PlusService, transport(""));
  const flowday = createHttpClient(
    FlowDayUiService,
    transport("/api/plus/flowday"),
  );
  async function ensureSynced(ids: string[]) {
    if (
      ids.every(
        (id) =>
          knownFlowTasks.has(id) ||
          id.startsWith("local-") ||
          id.startsWith("__flowday_"),
      )
    )
      return;
    for (let page = 0; page < 10; page++) {
      const result = await flowday.syncTasks({});
      if (result.state !== SyncTasksResponse_State.PARTIAL) return;
    }
    throw new Error("FlowDay is still importing tasks. Refresh and try again.");
  }
  return {
    async load() {
      const metadata = await plus.readPlan({});
      if (!metadata.plan) throw new Error("Planning metadata is missing.");
      const plan = metadata.plan;
      const tasks: PlanningTask[] = [];
      let pageToken = "";
      for (let page = 0; page < 10; page++) {
        const result = await plus.listPlanningTasks({
          pageSize: 200,
          pageToken,
        });
        tasks.push(...result.planningTasks.map(planningTask));
        pageToken = result.nextPageToken;
        if (!pageToken) break;
      }
      if (pageToken)
        throw new Error("Task list is incomplete. Counts have not been shown.");
      const [flow, timer] = await Promise.all([
        flowday.getFlow({ name: `flows/${plan.today}` }),
        flowday.getTimerSession({ name: "timerSession" }),
      ]);
      const estimates: Record<string, number> = {};
      const flowTasks: FocusState["flowTasks"] = {};
      let flowToken = "";
      for (let page = 0; page < 10; page++) {
        const result = await flowday.listTasks({
          pageSize: 200,
          pageToken: flowToken,
        });
        for (const task of result.tasks) {
          const id = task.name.slice("tasks/".length);
          flowTasks[id] = {
            title: task.title,
            local: !task.todoistId,
            estimatedMinutes: task.estimatedMinutes,
          };
          if (task.estimatedMinutes !== undefined)
            estimates[task.todoistId || id] = task.estimatedMinutes;
        }
        flowToken = result.nextPageToken;
        if (!flowToken) break;
      }
      if (flowToken)
        throw new Error(
          "FlowDay task list is incomplete. Refresh before planning.",
        );
      knownFlowTasks = new Set(Object.keys(flowTasks));
      const timerEtag = timer.etag || "0";
      const startedAt = timer.segmentStartTime
        ? new Date(Number(timer.segmentStartTime.seconds) * 1000).toISOString()
        : new Date().toISOString();
      const focus: FocusState = {
        date: plan.today,
        timerEtag,
        taskIds: flow.taskIds,
        completedTaskIds: flow.completedTaskIds,
        estimates,
        flowTasks,
        ...(timer.taskId &&
        (timer.state === TimerSession_State.RUNNING ||
          timer.state === TimerSession_State.PAUSED)
          ? {
              timer: {
                taskId: timer.taskId,
                flowDate: timer.flowDate,
                status:
                  timer.state === TimerSession_State.RUNNING
                    ? ("running" as const)
                    : ("paused" as const),
                elapsedSeconds: timer.savedSeconds,
                startedAt,
                etag: timerEtag,
              },
            }
          : {}),
      };
      return {
        plan: {
          tasks: tasks.map((task) => {
            const synced = flowTasks[task.id];
            return synced
              ? { ...task, estimatedMinutes: synced.estimatedMinutes }
              : task;
          }),
          week: plan.weekStart,
          timezone: plan.timezone,
          configured: plan.enabled,
          hiddenFilterIds: plan.hiddenFilterIds,
          flowdayUrl: plan.flowdayUrl,
          managedLabelNames: plan.labels.map((label) => label.label),
          managedLabels: plan.labels.map((label) => ({
            role: label.role,
            id: label.id,
            label: label.label,
          })),
        },
        focus,
      };
    },
    async updateTask(task, update) {
      await plus.setTaskPlan({
        taskId: task.id,
        etag: task.etag,
        requestId: crypto.randomUUID(),
        ...update,
      });
    },
    async createSteps(task, steps, requestId) {
      await plus.appendTaskSteps({ parentId: task.id, steps, requestId });
    },
    async updateLead(task, deadline, leadDays) {
      await plus.setTaskLead({
        taskId: task.id,
        etag: task.etag,
        requestId: crypto.randomUUID(),
        deadline,
        leadDays,
      });
    },
    async completeTask(task, requestId, flowDate) {
      await plus.completeTask({ taskId: task.id, requestId, flowDate });
    },
    async updateQueue(taskIds, focus) {
      await ensureSynced(taskIds);
      await flowday.updateFlow({
        flow: { name: `flows/${focus.date}`, taskIds },
        updateMask: { paths: ["task_ids"] },
      });
    },
    async updateEstimate(taskId, minutes) {
      await ensureSynced([taskId]);
      await flowday.updateTask({
        task: {
          name: `tasks/${taskId}`,
          ...(minutes > 0 ? { estimatedMinutes: minutes } : {}),
        },
        updateMask: { paths: ["estimated_minutes"] },
      });
    },
    async timer(action, taskId, focus) {
      const actions = {
        start: CommandTimerRequest_Action.START,
        pause: CommandTimerRequest_Action.PAUSE,
        resume: CommandTimerRequest_Action.RESUME,
        stop: CommandTimerRequest_Action.STOP,
      };
      const key = `${action}:${taskId}:${focus.timerEtag}`;
      const requestId = timerRequests.get(key) ?? crypto.randomUUID();
      timerRequests.set(key, requestId);
      await flowday.commandTimer({
        name: "timerSession",
        requestId,
        etag: focus.timerEtag,
        action: actions[action],
        taskId,
        flowDate:
          action === "start" ? focus.date : focus.timer?.flowDate || focus.date,
      });
      timerRequests.delete(key);
    },
  };
}
