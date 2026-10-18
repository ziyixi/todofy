import {
  createHttpClient,
  type HttpSend,
  RpcStatusError,
} from "@ziyixi/proto/http-client";
import {
  PlusService,
  type LaneOrder as ApiLaneOrder,
  type Plan as ApiPlan,
  type PlanningTask as ApiPlanningTask,
  type TaskDependency as ApiTaskDependency,
  type WeeklyBet as ApiWeeklyBet,
} from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import {
  CommandTimerRequest_Action,
  FlowDayUiService,
} from "@ziyixi/proto/flowday/ui/v1/flowday_ui_service_pb";
import {
  TimerSession_State,
  TimerSession_Mode,
  type TimerSession,
} from "@ziyixi/proto/flowday/ui/v1/time_entry_pb";
import type { Flow } from "@ziyixi/proto/flowday/ui/v1/flow_pb";
import { BET_AREAS, BetNotSaved } from "./bets";
import type {
  BetArea,
  FlowDayPlan,
  FocusState,
  LaneId,
  PlanMetadata,
  PlanningTask,
  PlusActions,
  ReorderResult,
  TaskDependency,
  TimerSnapshot,
  WeeklyBet,
} from "./model";

/** Todofy did not add a dependency; the message says why. */
class DependencyNotAddedError extends Error {}

export function planningTask(task: ApiPlanningTask): PlanningTask {
  return {
    id: task.id,
    title: task.title,
    parentId: task.parentId,
    projectId: task.projectId,
    labels: task.labels,
    ...(task.kind
      ? {
          kind: task.kind as PlanningTask["kind"],
          effort: task.effort as PlanningTask["effort"],
        }
      : {}),
    ...(task.explicitStage !== undefined
      ? {
          explicitStage: task.explicitStage as PlanningTask["stage"],
          planningFlags: task.planningFlags,
        }
      : {}),
    area: ["work", "personal"].includes(task.area)
      ? (task.area as PlanningTask["area"])
      : "unassigned",
    stage: ["quarterly", "monthly", "weekly", "committed"].includes(task.stage)
      ? (task.stage as PlanningTask["stage"])
      : "none",
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
    recurring: task.recurring,
    completedCount: task.completedCount,
    childOrder: task.childOrder,
    orderKey: task.orderKey,
    sortOrder: task.sortOrder,
  };
}
function taskDependency(dependency: ApiTaskDependency): TaskDependency {
  return {
    taskId: dependency.taskId,
    prerequisiteId: dependency.prerequisiteId,
    baselineCount: dependency.baselineCompletedCount,
    done: dependency.done,
  };
}
/**
 * Todofy refuses a dependency the page had allowed when another tab changed them meanwhile (a cycle
 * or the limit), and for reasons the same refusal also carries (planning or task writes paused): the
 * message names none of them. A task that is no longer active is said so.
 */
function dependencyError(error: unknown): unknown {
  if (!(error instanceof RpcStatusError)) return error;
  if (error.status.reason === "ACTION_NOT_ALLOWED")
    return new DependencyNotAddedError(
      "Not added: this dependency cannot be added now. Refresh and try again.",
    );
  if (error.status.reason === "NOT_FOUND")
    return new DependencyNotAddedError(
      "Not added: one of these tasks is no longer active. Refresh and try again.",
    );
  return error;
}
function weeklyBet(bet: ApiWeeklyBet): WeeklyBet | undefined {
  if (!BET_AREAS.includes(bet.area as BetArea)) return undefined;
  return {
    weekStart: bet.weekStart,
    area: bet.area as BetArea,
    text: bet.text,
    etag: bet.etag,
  };
}
/** The lanes Todofy keeps an order for (core/plan.py LANES). */
const LANES: readonly string[] = [
  "start",
  "waiting",
  "parked",
  "quarterly",
  "monthly",
  "weekly",
  "committed",
];
/** A lane's saved order; undefined for a lane this build does not know. */
function laneOrder(order: ApiLaneOrder): ReorderResult["lane"] {
  return LANES.includes(order.lane)
    ? { lane: order.lane as LaneId, taskIds: order.taskIds }
    : undefined;
}
function planMetadata(plan: ApiPlan): PlanMetadata {
  return {
    week: plan.weekStart,
    timezone: plan.timezone,
    configured: plan.enabled,
    ...(plan.mailboxPendingCount !== undefined
      ? { mailboxPendingCount: plan.mailboxPendingCount }
      : {}),
    flowdayUrl: plan.flowdayUrl,
    managedLabels: plan.labels.map((label) => ({
      role: label.role,
      id: label.id,
      label: label.label,
    })),
    reviewTaskId: plan.reviewTaskId,
    nextWeekTaskIds: plan.nextWeekTaskIds,
    dependencies: plan.dependencies.map(taskDependency),
    weeklyBets: plan.weeklyBets.flatMap((bet) => weeklyBet(bet) ?? []),
    laneOrders: Object.fromEntries(
      plan.laneOrders.flatMap((order) => {
        const saved = laneOrder(order);
        return saved ? [[saved.lane, saved.taskIds]] : [];
      }),
    ),
  };
}
function timerSnapshot(session: TimerSession): TimerSnapshot {
  const timerEtag = session.etag || "0";
  if (
    !session.taskId ||
    (session.state !== TimerSession_State.RUNNING &&
      session.state !== TimerSession_State.PAUSED)
  )
    return {
      timerEtag,
      ...(session.finishedPomodoroTaskId &&
      session.finishedPomodoroTargetSeconds
        ? {
            finishedPomodoro: {
              taskId: session.finishedPomodoroTaskId,
              targetSeconds: session.finishedPomodoroTargetSeconds,
            },
          }
        : {}),
    };
  return {
    timerEtag,
    timer: {
      taskId: session.taskId,
      flowDate: session.flowDate,
      status:
        session.state === TimerSession_State.RUNNING ? "running" : "paused",
      elapsedSeconds: session.savedSeconds,
      ...(session.mode === TimerSession_Mode.POMODORO
        ? {
            mode: "pomodoro" as const,
            targetSeconds: session.pomodoroTargetSeconds,
          }
        : {}),
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
/**
 * Adapts Todofy's planning API and FlowDay's focus API for Tasks. The host supplies authentication
 * and URL routing, and `updateEstimate`: an estimate is the task's duration in Tasks, never FlowDay's.
 * FlowDay's queues hold any task ID; FlowDay's own page syncs its mirror of the tasks.
 */
export function createPlanningActions(transports: {
  plus: HttpSend;
  flowday: HttpSend;
}): Omit<PlusActions, "updateEstimate"> {
  const timerRequests = new Map<string, string>();
  const plus = createHttpClient(PlusService, transports.plus);
  const flowday = createHttpClient(FlowDayUiService, transports.flowday);
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
    const flowTasks: FocusState["flowTasks"] = {};
    let pageToken = "";
    // The gateway caps a FlowDay page at 100 tasks.
    for (let page = 0; page < 20; page++) {
      const result = await flowday.listTasks({ pageSize: 100, pageToken });
      for (const task of result.tasks) {
        const id = task.name.slice("tasks/".length);
        // A Tasks task's estimate is its duration (load); only FlowDay's own tasks have one here.
        flowTasks[id] = task.todoistId
          ? { title: task.title, local: false }
          : {
              title: task.title,
              local: true,
              estimatedMinutes: task.estimatedMinutes,
            };
      }
      pageToken = result.nextPageToken;
      if (!pageToken) return flowTasks;
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
      const [metadata, tasks, flowTasks] = await Promise.all([
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
      // A task's duration is its only estimate; FlowDay's mirror may still be catching up.
      const estimates: Record<string, number> = {};
      for (const task of tasks) estimates[task.id] = task.estimatedMinutes ?? 0;
      const focus: FocusState = {
        ...today,
        ...timerSnapshot(timer),
        estimates,
        flowTasks,
      };
      return {
        plan: { ...planMetadata(plan), tasks },
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
    async setWeeklyBet(bet) {
      let result;
      try {
        result = await plus.setWeeklyBet(bet);
      } catch (error) {
        const reason =
          error instanceof RpcStatusError ? error.status.reason : undefined;
        if (reason === "ETAG_MISMATCH") throw new BetNotSaved("changed");
        // The only write Todofy refuses for a configured plan: a week that has ended.
        if (reason === "ACTION_NOT_ALLOWED") throw new BetNotSaved("ended");
        throw error;
      }
      const saved = result.weeklyBet && weeklyBet(result.weeklyBet);
      if (!saved) throw new Error("The saved goal could not be read.");
      return saved;
    },
    async createSteps(task, steps, requestId) {
      const result = await plus.appendTaskSteps({
        parentId: task.id,
        steps,
        requestId,
      });
      return result.taskIds;
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
    async setDependency(taskId, prerequisiteId, waits) {
      try {
        const result = await plus.setTaskDependency({
          taskId,
          prerequisiteId,
          waits,
          requestId: crypto.randomUUID(),
        });
        return {
          forTask: taskId,
          dependencies: result.dependencies.map(taskDependency),
        };
      } catch (error) {
        throw waits ? dependencyError(error) : error;
      }
    },
    async resolveDependencies(taskIds) {
      const result = await plus.resolveDependencies({
        taskIds,
        requestId: crypto.randomUUID(),
      });
      return {
        dependencies: result.dependencies.map(taskDependency),
        dropped: result.droppedTaskIds,
        released: result.releasedTaskIds,
      };
    },
    async addToDay(taskId, date) {
      return editDay(date, (taskIds) =>
        taskIds.includes(taskId) ? taskIds : [...taskIds, taskId],
      );
    },
    async removeFromDay(taskId, date) {
      return editDay(date, (taskIds) => taskIds.filter((id) => id !== taskId));
    },
    async moveTaskToDay(taskId, source, target, beforeId) {
      if (source?.date === target.date && beforeId === taskId) return [];
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
    async readTimer() {
      return timerSnapshot(
        await flowday.getTimerSession({ name: "timerSession" }),
      );
    },
    async timer(action, taskId, focus, targetSeconds) {
      const actions = {
        start: CommandTimerRequest_Action.START,
        pause: CommandTimerRequest_Action.PAUSE,
        resume: CommandTimerRequest_Action.RESUME,
        stop: CommandTimerRequest_Action.STOP,
        finish: CommandTimerRequest_Action.FINISH_POMODORO,
      };
      const key = `${action}:${taskId}:${focus.timerEtag}:${targetSeconds ?? 0}`;
      const requestId = timerRequests.get(key) ?? crypto.randomUUID();
      timerRequests.set(key, requestId);
      const confirmed = await flowday.commandTimer({
        name: "timerSession",
        requestId,
        etag: focus.timerEtag,
        action: actions[action],
        ...(action === "start" && targetSeconds
          ? { mode: TimerSession_Mode.POMODORO, targetSeconds }
          : {}),
        taskId,
        flowDate:
          action === "start" ? focus.date : focus.timer?.flowDate || focus.date,
      });
      timerRequests.delete(key);
      return timerSnapshot(confirmed);
    },
    async reorderTasks(taskIds, movedId, lane, requestId) {
      const result = await plus.reorderTasks({
        requestId,
        taskIds,
        taskId: movedId,
        lane,
      });
      return {
        reordered: result.tasks.map(planningTask),
        lane: result.laneOrder && laneOrder(result.laneOrder),
      };
    },
  };
}
