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
  FocusEntry_Source,
  FocusTimer_State,
  type FocusDay as ApiFocusDay,
  type FocusEntry as ApiFocusEntry,
  type FocusTimer as ApiFocusTimer,
} from "@ziyixi/proto/tasks/ui/v1/focus_pb";
import {
  CommandFocusTimerRequest_Action,
  TasksUiService,
} from "@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb";
import { BET_AREAS, BetNotSaved } from "./bets";
import { addDays } from "./domain";
import type {
  Area,
  BetArea,
  DayPlan,
  DayQueue,
  FocusEntry,
  FocusRange,
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
    today: plan.today,
    timezone: plan.timezone,
    configured: plan.enabled,
    ...(plan.mailboxPendingCount !== undefined
      ? { mailboxPendingCount: plan.mailboxPendingCount }
      : {}),
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
/** Tasks keeps "" for unassigned. */
function area(value: string): Area {
  return value === "work" || value === "personal" ? value : "unassigned";
}
function wireArea(value: Area | undefined): string {
  return value === "work" || value === "personal" ? value : "";
}
function isoTime(time: { seconds: bigint } | undefined): string | undefined {
  return time && new Date(Number(time.seconds) * 1000).toISOString();
}
function focusEntry(entry: ApiFocusEntry): FocusEntry {
  const startedAt = isoTime(entry.startTime);
  return {
    id: entry.name.slice("focusEntries/".length),
    taskId: entry.taskId,
    date: entry.day,
    seconds: entry.seconds,
    ...(startedAt ? { startedAt } : {}),
    source: entry.source === FocusEntry_Source.TIMER ? "timer" : "manual",
    area: area(entry.area),
    etag: entry.etag,
  };
}
function dayQueue(day: ApiFocusDay): DayQueue {
  return {
    date: day.day,
    taskIds: day.taskIds,
    completedTaskIds: day.doneTaskIds,
  };
}
function timerSnapshot(
  timer: ApiFocusTimer,
  entry?: ApiFocusEntry,
): TimerSnapshot {
  const timerEtag = timer.etag || "0";
  const saved = entry ? { entry: focusEntry(entry) } : {};
  if (
    !timer.taskId ||
    (timer.state !== FocusTimer_State.RUNNING &&
      timer.state !== FocusTimer_State.PAUSED)
  )
    return {
      timerEtag,
      ...(timer.finishedTaskId && timer.finishedSeconds
        ? {
            finishedPomodoro: {
              taskId: timer.finishedTaskId,
              targetSeconds: timer.finishedSeconds,
            },
          }
        : {}),
      ...saved,
    };
  return {
    timerEtag,
    timer: {
      taskId: timer.taskId,
      day: timer.day,
      area: area(timer.area),
      status: timer.state === FocusTimer_State.RUNNING ? "running" : "paused",
      elapsedSeconds: timer.savedSeconds,
      ...(timer.targetSeconds
        ? { mode: "pomodoro" as const, targetSeconds: timer.targetSeconds }
        : {}),
      startedAt: isoTime(timer.segmentStartTime) ?? new Date().toISOString(),
      etag: timerEtag,
    },
    ...saved,
  };
}
/**
 * Adapts Todofy's planning API and Tasks' Focus API. The host supplies authentication and URL
 * routing, `updateEstimate` (an estimate is the task's duration in Tasks) and `completeTask`, which
 * completes in Tasks and settles Focus in the same write.
 */
export function createPlanningActions(transports: {
  plus: HttpSend;
  tasks: HttpSend;
}): Omit<PlusActions, "updateEstimate" | "completeTask"> {
  const plus = createHttpClient(PlusService, transports.plus);
  const focus = createHttpClient(TasksUiService, transports.tasks);
  // One request ID per identical write until it is confirmed, so a retry after a lost answer
  // replays it instead of writing again.
  const requests = new Map<string, string>();
  async function once<T>(
    key: string,
    write: (requestId: string) => Promise<T>,
  ): Promise<T> {
    const requestId = requests.get(key) ?? crypto.randomUUID();
    requests.set(key, requestId);
    const result = await write(requestId);
    requests.delete(key);
    return result;
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
  /** At most 7 days, which one ListFocusDays reads. */
  async function readDays(start: string, end: string): Promise<FocusRange> {
    const result = await focus.listFocusDays({ startDay: start, endDay: end });
    const days = result.days.map((day): DayPlan => ({
      ...dayQueue(day),
      entries: [],
    }));
    for (const entry of result.entries)
      days
        .find((day) => day.date === entry.day)
        ?.entries.push(focusEntry(entry));
    const tasks: FocusRange["tasks"] = {};
    for (const task of result.tasks)
      tasks[task.taskId] = {
        title: task.title,
        parentId: task.parentId,
        parentTitle: task.parentTitle,
        ...(task.durationMinutes
          ? { estimatedMinutes: task.durationMinutes }
          : {}),
        completed: task.completed,
      };
    return { days, tasks, today: result.today };
  }
  async function moveStep(
    taskId: string,
    sourceDay: string,
    destinationDay: string,
    beforeTaskId = "",
  ): Promise<DayQueue[]> {
    const result = await once(
      `move:${taskId}:${sourceDay}:${destinationDay}:${beforeTaskId}`,
      (requestId) =>
        focus.moveFocusStep({
          requestId,
          taskId,
          sourceDay,
          destinationDay,
          beforeTaskId,
        }),
    );
    return result.days.map(dayQueue);
  }
  async function loadDays(weekStart: string): Promise<DayPlan[]> {
    return (await readDays(weekStart, addDays(weekStart, 6))).days;
  }
  return {
    loadDays,
    async load(weekStart) {
      const [metadata, tasks, timer, shown] = await Promise.all([
        plus.readPlan({}),
        loadPlanningTasks(),
        focus.getFocusTimer({ name: "focusTimer" }),
        weekStart ? readDays(weekStart, addDays(weekStart, 6)) : undefined,
      ]);
      if (!metadata.plan) throw new Error("Planning metadata is missing.");
      const plan = metadata.plan;
      const week =
        shown ?? (await readDays(plan.weekStart, addDays(plan.weekStart, 6)));
      // Focus is on Tasks' today, which the displayed week may not include.
      const current = week.days.some((day) => day.date === week.today)
        ? week
        : await readDays(week.today, week.today);
      const today = current.days.find((day) => day.date === week.today);
      if (!today) throw new Error("Today's planning day is missing.");
      // A task's duration in Tasks is its only estimate.
      const estimates: Record<string, number> = {};
      for (const task of tasks) estimates[task.id] = task.estimatedMinutes ?? 0;
      const focusState: FocusState = {
        ...today,
        ...timerSnapshot(timer),
        estimates,
        tasks: { ...week.tasks, ...current.tasks },
      };
      return {
        plan: { ...planMetadata(plan), tasks },
        focus: focusState,
        days: week.days,
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
      return moveStep(taskId, "", date);
    },
    async removeFromDay(taskId, date) {
      return moveStep(taskId, date, "");
    },
    async moveTaskToDay(taskId, source, target, beforeId) {
      if (source?.date === target.date && beforeId === taskId) return [];
      return moveStep(taskId, source?.date ?? "", target.date, beforeId);
    },
    async readTimer() {
      return timerSnapshot(await focus.getFocusTimer({ name: "focusTimer" }));
    },
    async timer(action, taskId, state, targetSeconds, taskArea) {
      const actions = {
        start: CommandFocusTimerRequest_Action.START,
        pause: CommandFocusTimerRequest_Action.PAUSE,
        resume: CommandFocusTimerRequest_Action.RESUME,
        stop: CommandFocusTimerRequest_Action.STOP,
        finish: CommandFocusTimerRequest_Action.FINISH,
      };
      const start = action === "start";
      const confirmed = await once(
        `timer:${action}:${taskId}:${state.timerEtag}:${start ? `${targetSeconds ?? 0}:${wireArea(taskArea)}` : ""}`,
        (requestId) =>
          focus.commandFocusTimer({
            name: "focusTimer",
            requestId,
            etag: state.timerEtag,
            action: actions[action],
            taskId,
            ...(start
              ? {
                  ...(targetSeconds ? { targetSeconds } : {}),
                  area: wireArea(taskArea),
                }
              : {}),
          }),
      );
      if (!confirmed.timer) throw new Error("The timer could not be read.");
      return timerSnapshot(confirmed.timer, confirmed.entry);
    },
    async readFocus(start, end) {
      // One ListFocusDays reads at most 7 days; a month is at most 6 of them, read together.
      const starts: string[] = [];
      for (let day = start; day <= end; day = addDays(day, 7)) starts.push(day);
      const ranges = await Promise.all(
        starts.map((day) => {
          const last = addDays(day, 6);
          return readDays(day, last < end ? last : end);
        }),
      );
      return {
        days: ranges.flatMap((range) => range.days),
        tasks: Object.assign({}, ...ranges.map((range) => range.tasks)),
        today: ranges[0]?.today ?? "",
      };
    },
    async addEntry(entry) {
      const saved = await once(
        `add:${entry.taskId}:${entry.date}:${entry.seconds}:${entry.area}`,
        (requestId) =>
          focus.createFocusEntry({
            requestId,
            focusEntry: {
              taskId: entry.taskId,
              day: entry.date,
              seconds: entry.seconds,
              area: wireArea(entry.area),
            },
          }),
      );
      return { savedEntry: focusEntry(saved) };
    },
    async updateEntry(entry, seconds) {
      const saved = await once(
        `update:${entry.id}:${entry.etag}:${seconds}`,
        (requestId) =>
          focus.updateFocusEntry({
            requestId,
            etag: entry.etag,
            focusEntry: { name: `focusEntries/${entry.id}`, seconds },
            updateMask: { paths: ["seconds"] },
          }),
      );
      return { savedEntry: focusEntry(saved) };
    },
    async deleteEntry(entry) {
      await once(`delete:${entry.id}:${entry.etag}`, (requestId) =>
        focus.deleteFocusEntry({
          name: `focusEntries/${entry.id}`,
          etag: entry.etag,
          requestId,
        }),
      );
      return { deletedEntry: { id: entry.id, date: entry.date } };
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
