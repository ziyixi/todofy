import {
  createHttpClient,
  HttpResponseError,
  RpcStatusError,
} from "@ziyixi/proto/http-client";
import {
  PlusService,
  type Plan as ApiPlan,
  type PlanningTask as ApiPlanningTask,
} from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import {
  CommandTimerRequest_Action,
  FlowDayUiService,
  SyncTasksResponse_State,
  SyncTasksRequest_Mode,
} from "@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb";
import {
  TimerSession_State,
  type TimerSession,
} from "@ziyixi/proto/flowday/ui/v1/time_entry_pb";
import type { Flow } from "@ziyixi/proto/flowday/ui/v1/flow_pb";
import type {
  FlowDayPlan,
  FocusState,
  PlanMetadata,
  PlanningTask,
  PlusActions,
  TimerSnapshot,
} from "./model";

export interface Connection {
  apiOrigin: string;
  token: string;
}
/** Keeps FlowDay task IDs (never titles) beyond one background worker's lifetime. */
export interface KnownTaskStore {
  read(): Promise<string[]>;
  write(ids: string[]): Promise<void>;
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
class FlowdaySyncPendingError extends Error {}

export function publicError(error: unknown): string {
  if (error instanceof FlowdaySyncPendingError) return error.message;
  // The gateway refuses an unknown or revoked extension token with a 401 Status body.
  if (
    (error instanceof RpcStatusError && error.status.httpStatus === 401) ||
    (error instanceof HttpResponseError && error.httpStatus === 401)
  )
    return "Connection expired or revoked. Open connection settings.";
  if (error instanceof RpcStatusError)
    return error.status.localizedMessage?.message ?? error.status.message;
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
    stage: ["quarterly", "monthly", "weekly", "committed"].includes(task.stage)
      ? (task.stage as PlanningTask["stage"])
      : "none",
    bet: task.bet,
    priority: task.priority || 1,
    deadline: task.deadline,
    due: task.due,
    leadDays: task.leadDays,
    estimatedMinutes: task.estimatedMinutes,
    etag: task.etag,
    mustStart: task.mustStart,
    missingLead: task.missingLead,
    updatedAt:
      task.updateTime &&
      new Date(Number(task.updateTime.seconds) * 1000).toISOString(),
  };
}
function planMetadata(plan: ApiPlan): PlanMetadata {
  return {
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
    etag: plan.etag,
    availableLabels: plan.availableLabels.map((label) => ({
      id: label.id,
      label: label.label,
    })),
    inboxProjectId: plan.inboxProjectId,
    reviewTaskId: plan.reviewTaskId,
    nextWeekTaskIds: plan.nextWeekTaskIds,
  };
}
function timerSnapshot(session: TimerSession): TimerSnapshot {
  const timerEtag = session.etag || "0";
  if (
    !session.taskId ||
    (session.state !== TimerSession_State.RUNNING &&
      session.state !== TimerSession_State.PAUSED)
  )
    return { timerEtag };
  return {
    timerEtag,
    timer: {
      taskId: session.taskId,
      flowDate: session.flowDate,
      status:
        session.state === TimerSession_State.RUNNING ? "running" : "paused",
      elapsedSeconds: session.savedSeconds,
      startedAt: session.segmentStartTime
        ? new Date(
            Number(session.segmentStartTime.seconds) * 1000,
          ).toISOString()
        : new Date().toISOString(),
      etag: timerEtag,
    },
  };
}
function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(`${weekStart}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
}
function flowPlan(flow: Flow): FlowDayPlan {
  return {
    date: flow.name.slice("flows/".length),
    taskIds: flow.taskIds,
    completedTaskIds: flow.completedTaskIds,
  };
}
export function createApi(
  connection: Connection,
  fetcher: typeof fetch = fetch,
  knownStore?: KnownTaskStore,
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
  // Tasks FlowDay already has, so queue and estimate writes skip its manual Todoist sync,
  // which FlowDay throttles to one every 30 seconds.
  let knownFlowTasks = new Set<string>();
  const restored = (knownStore?.read() ?? Promise.resolve([]))
    .then((ids) => {
      for (const id of ids) knownFlowTasks.add(id);
    })
    .catch(() => {});
  async function remember(ids: Iterable<string>, replace = false) {
    await restored;
    knownFlowTasks = new Set([...(replace ? [] : knownFlowTasks), ...ids]);
    // A lost copy only costs one extra sync, so the write never delays the action.
    void knownStore?.write([...knownFlowTasks]).catch(() => {});
  }
  const plus = createHttpClient(PlusService, transport(""));
  const flowday = createHttpClient(
    FlowDayUiService,
    transport("/api/plus/flowday"),
  );
  async function ensureSynced(ids: string[]) {
    await restored;
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
      const result = await flowday.syncTasks({
        mode: SyncTasksRequest_Mode.MANUAL,
      });
      if (result.state === SyncTasksResponse_State.SYNCED) {
        await remember(ids);
        return;
      }
      if (result.state === SyncTasksResponse_State.THROTTLED)
        throw new FlowdaySyncPendingError(
          "FlowDay just synced. Wait briefly and try adding or estimating this task again.",
        );
      if (result.state !== SyncTasksResponse_State.PARTIAL)
        throw new FlowdaySyncPendingError(
          "FlowDay could not confirm this sync. Refresh and try again.",
        );
    }
    throw new FlowdaySyncPendingError(
      "FlowDay is still importing tasks. Refresh and try again.",
    );
  }
  async function loadPlanningTasks(): Promise<PlanningTask[]> {
    const tasks: PlanningTask[] = [];
    let pageToken = "";
    for (let page = 0; page < 10; page++) {
      const result = await plus.listPlanningTasks({ pageSize: 200, pageToken });
      tasks.push(...result.planningTasks.map(planningTask));
      pageToken = result.nextPageToken;
      if (!pageToken) return tasks;
    }
    throw new Error("Task list is incomplete. Counts have not been shown.");
  }
  async function loadFlowTasks() {
    const estimates: Record<string, number> = {};
    const flowTasks: FocusState["flowTasks"] = {};
    let pageToken = "";
    for (let page = 0; page < 10; page++) {
      const result = await flowday.listTasks({ pageSize: 200, pageToken });
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
      pageToken = result.nextPageToken;
      if (!pageToken) return { estimates, flowTasks };
    }
    throw new Error(
      "FlowDay task list is incomplete. Refresh before planning.",
    );
  }
  // A queue shown on screen may be out of date (another tab, an earlier queued write), and
  // UpdateFlow keeps the last write, so one-step edits start from FlowDay's current queue.
  async function editDay(date: string, edit: (taskIds: string[]) => string[]) {
    const current = await flowday.getFlow({ name: `flows/${date}` });
    const taskIds = edit(current.taskIds);
    if (taskIds.length === current.taskIds.length) return [flowPlan(current)];
    const confirmed = await flowday.updateFlow({
      flow: { name: `flows/${date}`, taskIds },
      updateMask: { paths: ["task_ids"] },
    });
    return [flowPlan(confirmed)];
  }
  async function loadDays(weekStart: string): Promise<FlowDayPlan[]> {
    const dates = weekDates(weekStart);
    const flows = await Promise.all(
      dates.map((date) => flowday.getFlow({ name: `flows/${date}` })),
    );
    return flows.map(flowPlan);
  }
  return {
    loadDays,
    async load(weekStart) {
      const [metadata, tasks, { estimates, flowTasks }] = await Promise.all([
        plus.readPlan({}),
        loadPlanningTasks(),
        loadFlowTasks(),
      ]);
      if (!metadata.plan) throw new Error("Planning metadata is missing.");
      const plan = metadata.plan;
      const displayedWeek = weekStart || plan.weekStart;
      const includesToday = weekDates(displayedWeek).includes(plan.today);
      const [days, timer, todayFlow] = await Promise.all([
        loadDays(displayedWeek),
        flowday.getTimerSession({ name: "timerSession" }),
        includesToday
          ? undefined
          : flowday.getFlow({ name: `flows/${plan.today}` }),
      ]);
      const today =
        days.find((day) => day.date === plan.today) ??
        (todayFlow && flowPlan(todayFlow));
      if (!today) throw new Error("Today's planning day is missing.");
      await remember(Object.keys(flowTasks), true);
      const focus: FocusState = {
        ...today,
        ...timerSnapshot(timer),
        estimates,
        flowTasks,
      };
      return {
        plan: {
          ...planMetadata(plan),
          tasks: tasks.map((task) => {
            const synced = flowTasks[task.id];
            return synced
              ? { ...task, estimatedMinutes: synced.estimatedMinutes }
              : task;
          }),
        },
        focus,
        days,
      };
    },
    async readPlan() {
      const result = await plus.readPlan({});
      if (!result.plan) throw new Error("Planning metadata is missing.");
      return planMetadata(result.plan);
    },
    async updateTask(task, update) {
      const result = await plus.setTaskPlan({
        taskId: task.id,
        etag: task.etag,
        requestId: crypto.randomUUID(),
        ...update,
      });
      if (!result.task) throw new Error("The saved task could not be read.");
      return {
        ...planningTask(result.task),
        estimatedMinutes: task.estimatedMinutes,
      };
    },
    async updateLabels(labels, etag) {
      const result = await plus.updatePlanLabels({
        labels,
        etag,
        requestId: crypto.randomUUID(),
      });
      if (!result.plan) throw new Error("The saved labels could not be read.");
      return planMetadata(result.plan);
    },
    async createSteps(task, steps, requestId) {
      await plus.appendTaskSteps({ parentId: task.id, steps, requestId });
    },
    async updateLead(task, deadline, leadDays) {
      const result = await plus.setTaskLead({
        taskId: task.id,
        etag: task.etag,
        requestId: crypto.randomUUID(),
        deadline,
        leadDays,
      });
      if (!result.task) throw new Error("The saved task could not be read.");
      return {
        ...planningTask(result.task),
        estimatedMinutes: task.estimatedMinutes,
      };
    },
    async completeTask(task, requestId, flowDate) {
      await plus.completeTask({ taskId: task.id, requestId, flowDate });
    },
    async addToDay(taskId, date) {
      await ensureSynced([taskId]);
      return editDay(date, (taskIds) =>
        taskIds.includes(taskId) ? taskIds : [...taskIds, taskId],
      );
    },
    async removeFromDay(taskId, date) {
      return editDay(date, (taskIds) => taskIds.filter((id) => id !== taskId));
    },
    async moveTaskToDay(taskId, source, target, beforeId) {
      if (source?.date === target.date && beforeId === taskId) return [];
      await ensureSynced([taskId]);
      let confirmedSource: FlowDayPlan | undefined;
      let destination: Flow;
      if (source && source.date !== target.date) {
        const moved = await flowday.rolloverFlow({
          name: `flows/${source.date}`,
          destination: `flows/${target.date}`,
          taskIds: [taskId],
        });
        if (!moved.flow || !moved.destinationFlow)
          throw new Error("The moved day queues could not be read.");
        confirmedSource = flowPlan(moved.flow);
        destination = moved.destinationFlow;
      } else {
        destination = await flowday.getFlow({ name: `flows/${target.date}` });
      }
      if (source && !destination.taskIds.includes(taskId))
        throw new Error("This step has moved. Refresh the plan and try again.");
      const taskIds = destination.taskIds.filter((id) => id !== taskId);
      const before = beforeId ? taskIds.indexOf(beforeId) : -1;
      taskIds.splice(before < 0 ? taskIds.length : before, 0, taskId);
      if (
        taskIds.every((id, index) => destination.taskIds[index] === id) &&
        taskIds.length === destination.taskIds.length
      )
        return confirmedSource ? [confirmedSource, flowPlan(destination)] : [];
      const confirmed = await flowday.updateFlow({
        flow: { name: `flows/${target.date}`, taskIds },
        updateMask: { paths: ["task_ids"] },
      });
      const confirmedTarget = flowPlan(confirmed);
      return confirmedSource
        ? [confirmedSource, confirmedTarget]
        : [confirmedTarget];
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
      const confirmed = await flowday.commandTimer({
        name: "timerSession",
        requestId,
        etag: focus.timerEtag,
        action: actions[action],
        taskId,
        flowDate:
          action === "start" ? focus.date : focus.timer?.flowDate || focus.date,
      });
      timerRequests.delete(key);
      return timerSnapshot(confirmed);
    },
  };
}
