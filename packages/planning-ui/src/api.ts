import {
  createHttpClient,
  type HttpSend,
  RpcStatusError,
} from "@ziyixi/proto/http-client";
import { PlusService } from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import {
  FocusEntry_Source,
  FocusTimer_State,
  type FocusDay as ApiFocusDay,
  type FocusEntry as ApiFocusEntry,
  type FocusTimer as ApiFocusTimer,
} from "@ziyixi/proto/tasks/ui/v1/focus_pb";
import type {
  LaneOrder as ApiLaneOrder,
  Plan as ApiPlan,
  WeeklyBet as ApiWeeklyBet,
} from "@ziyixi/proto/tasks/ui/v1/plan_pb";
import type { MessageInitShape } from "@ziyixi/proto/protobuf";
import type { Task, TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
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
  PlanUpdate,
  PlusActions,
  ReorderResult,
  TaskDependency,
  TimerSnapshot,
  WeeklyBet,
} from "./model";

/** Tasks did not add a dependency; the message says why. */
class DependencyNotAddedError extends Error {}

/** The planning flags PlanUpdate's switches set, as Task.planning_flags names them. */
const FLAGS: Partial<Record<keyof PlanUpdate, string>> = {
  active: "active",
  parked: "parked",
  quick: "quick",
  waiting: "waiting",
  routine: "routine",
  onHold: "onhold",
  blocked: "blocked",
  singleAction: "task",
};
/** Review lanes whose order changes no task: they sort by update time. */
const UNTOUCHED_LANES: readonly string[] = ["waiting", "parked"];
/** Plan reads at most this many pages of 100 open tasks. */
const MAX_PAGES = 20;

/** A Task as Plan shows it: its saved stage is explicitStage, and its Review lane's is stage. */
export function planningTask(task: Task): PlanningTask {
  const position = task.sortOrder ?? 0;
  return {
    id: task.id,
    title: task.title,
    parentId: task.parentId,
    projectId: task.projectId,
    sectionId: task.sectionId,
    kind: task.kind === "step" ? "step" : "task",
    effort: task.effort as PlanningTask["effort"],
    explicitStage: stage(task.stage),
    planningFlags: task.planningFlags,
    area:
      task.area === "work" || task.area === "personal"
        ? task.area
        : "unassigned",
    stage: stage(task.boardStage),
    // Plan's order is the API's, 4 for P1; Tasks' is the domain's, 1 for P1.
    priority: 5 - (task.priority || 4),
    deadline: task.deadline,
    due: task.dueDate,
    leadDays: task.leadDays,
    estimatedMinutes: task.durationMinutes || undefined,
    etag: task.etag,
    mustStart: task.mustStart,
    missingLead: task.missingLead,
    updatedAt: isoTime(task.updateTime),
    recurring: Boolean(task.recurrence),
    completedCount: task.completedCount,
    childOrder:
      Number.isInteger(position) && Math.abs(position) < 2 ** 31
        ? position
        : undefined,
    sortOrder: position,
  };
}
function stage(value: string): PlanningTask["stage"] {
  return value === "quarterly" ||
    value === "monthly" ||
    value === "weekly" ||
    value === "committed"
    ? value
    : "none";
}
function taskDependencies(task: Task): TaskDependency[] {
  return task.dependencies.map((dependency) => ({
    taskId: task.id,
    prerequisiteId: dependency.prerequisiteId,
    done: dependency.done,
  }));
}
/**
 * Tasks refuses a dependency the page had allowed when another tab changed them meanwhile (a cycle
 * or the limit), or when one of the tasks is no longer open: the message names none of them.
 */
function dependencyError(error: unknown): unknown {
  if (!(error instanceof RpcStatusError)) return error;
  if (error.status.reason === "PRECONDITION_FAILED")
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
/** The lanes Tasks keeps an order for, in board order. */
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
    timezone: plan.timeZone,
    nextWeekTaskIds: plan.nextWeekTaskIds,
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
 * The moved task's siblings among `tasks` (same project, section and parent) take their existing
 * positions in the given order; only those whose position changes are written, under the etag Plan
 * holds.
 */
export function siblingPositions(
  tasks: readonly PlanningTask[],
  movedId: string,
) {
  const moved = tasks.find((task) => task.id === movedId);
  if (!moved) return [];
  const siblings = tasks.filter(
    (task) =>
      task.projectId === moved.projectId &&
      task.sectionId === moved.sectionId &&
      task.parentId === moved.parentId,
  );
  const positions = siblings
    .map((task) => task.sortOrder ?? 0)
    .sort((left, right) => left - right);
  return siblings.flatMap((task, index) => {
    const sortOrder = positions[index] ?? 0;
    return sortOrder === (task.sortOrder ?? 0)
      ? []
      : [{ name: `tasks/${task.id}`, etag: task.etag, sortOrder }];
  });
}
/**
 * Adapts Tasks' planning and Focus API, and the weekly review's two facts Todofy keeps. The host
 * supplies authentication and URL routing, `updateEstimate` (an estimate is the task's duration in
 * Tasks) and `completeTask`, which completes in Tasks and settles Focus in the same write. A task
 * write reads nothing first: it goes under the etag Plan holds, which every confirmed task write
 * answers anew, and a stale one is refused, after which Plan reads again.
 */
export function createPlanningActions(transports: {
  plus: HttpSend;
  tasks: HttpSend;
}): Omit<PlusActions, "updateEstimate" | "completeTask"> {
  const plus = createHttpClient(PlusService, transports.plus);
  const tasks = createHttpClient(TasksUiService, transports.tasks);
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
  // A write a caller retries under its own request ID is resent as it was first built, so Tasks
  // replays it even when the tasks it was built from have changed since.
  const built = new Map<string, unknown>();
  function sameAs<T>(requestId: string, build: () => T): T {
    if (!built.has(requestId)) built.set(requestId, build());
    return built.get(requestId) as T;
  }
  async function loadTasks(): Promise<Task[]> {
    const listed: Task[] = [];
    let pageToken = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await tasks.listTasks({
        view: "all",
        pageSize: 100,
        pageToken,
      });
      listed.push(...result.tasks);
      pageToken = result.nextPageToken;
      if (!pageToken) return listed;
    }
    throw new Error("Task list is incomplete. Counts have not been shown.");
  }
  /** At most 7 days, which one ListFocusDays reads; no range reads Tasks' today's week. */
  async function readDays(start = "", end = ""): Promise<FocusRange> {
    const result = await tasks.listFocusDays({ startDay: start, endDay: end });
    const days = result.days.map((day): DayPlan => ({
      ...dayQueue(day),
      entries: [],
    }));
    for (const entry of result.entries)
      days
        .find((day) => day.date === entry.day)
        ?.entries.push(focusEntry(entry));
    const named: FocusRange["tasks"] = {};
    for (const task of result.tasks)
      named[task.taskId] = {
        title: task.title,
        parentId: task.parentId,
        parentTitle: task.parentTitle,
        ...(task.durationMinutes
          ? { estimatedMinutes: task.durationMinutes }
          : {}),
        completed: task.completed,
      };
    return { days, tasks: named, today: result.today };
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
        tasks.moveFocusStep({
          requestId,
          taskId,
          sourceDay,
          destinationDay,
          beforeTaskId,
        }),
    );
    return result.days.map(dayQueue);
  }
  async function loadDays(weekStart: string): Promise<FocusRange> {
    return readDays(weekStart, addDays(weekStart, 6));
  }
  /** One UpdateTask of planning paths; the answer keeps the estimate Plan shows. */
  async function save(
    task: PlanningTask,
    paths: string[],
    values: Pick<
      MessageInitShape<typeof TaskSchema>,
      "stage" | "area" | "planningFlags" | "deadline" | "leadDays"
    >,
  ): Promise<PlanningTask> {
    const saved = await tasks.updateTask({
      requestId: crypto.randomUUID(),
      etag: task.etag,
      task: { name: `tasks/${task.id}`, ...values },
      updateMask: { paths },
    });
    return { ...planningTask(saved), estimatedMinutes: task.estimatedMinutes };
  }
  return {
    loadDays,
    async load(weekStart) {
      const [plan, listed, timer, shown] = await Promise.all([
        tasks.getPlan({ name: "plan" }),
        loadTasks(),
        tasks.getFocusTimer({ name: "focusTimer" }),
        weekStart ? readDays(weekStart, addDays(weekStart, 6)) : readDays(),
      ]);
      // Focus is on Tasks' today, which the displayed week may not include.
      const current = shown.days.some((day) => day.date === shown.today)
        ? shown
        : await readDays(shown.today, shown.today);
      const today = current.days.find((day) => day.date === shown.today);
      if (!today) throw new Error("Today's planning day is missing.");
      const planned = listed.map(planningTask);
      // A task's duration in Tasks is its only estimate.
      const estimates: Record<string, number> = {};
      for (const task of planned)
        estimates[task.id] = task.estimatedMinutes ?? 0;
      const focusState: FocusState = {
        ...today,
        ...timerSnapshot(timer),
        estimates,
        tasks: { ...shown.tasks, ...current.tasks },
      };
      return {
        plan: {
          ...planMetadata(plan),
          tasks: planned,
          dependencies: listed.flatMap(taskDependencies),
        },
        focus: focusState,
        days: shown.days,
      };
    },
    async readPlan() {
      return planMetadata(await tasks.getPlan({ name: "plan" }));
    },
    async readWeeklyReview(week) {
      const result = await plus.readWeeklyReview({ weekStart: week });
      return {
        reviewTaskId: result.reviewTaskId,
        mailboxPendingCount: result.mailboxPendingCount,
      };
    },
    async updateTask(task, update) {
      const flags = new Set(task.planningFlags ?? []);
      for (const [field, flag] of Object.entries(FLAGS)) {
        const value = update[field as keyof PlanUpdate];
        if (value === true) flags.add(flag);
        if (value === false) flags.delete(flag);
      }
      const paths: string[] = [];
      if (update.stage !== undefined) paths.push("stage");
      if (update.area !== undefined) paths.push("area");
      if (Object.keys(FLAGS).some((field) => field in update))
        paths.push("planning_flags");
      return save(task, paths, {
        stage: update.stage ?? "",
        area: update.area ?? "",
        planningFlags: [...flags],
      });
    },
    async setWeeklyBet(bet) {
      let result;
      try {
        result = await tasks.updateWeeklyBet({
          weeklyBet: {
            name: `weeklyBets/${bet.weekStart}-${bet.area}`,
            text: bet.text,
          },
          updateMask: { paths: ["text"] },
          etag: bet.etag,
        });
      } catch (error) {
        const reason =
          error instanceof RpcStatusError ? error.status.reason : undefined;
        if (reason === "ETAG_MISMATCH") throw new BetNotSaved("changed");
        // The only other refusal of a well-formed Bet: its week has ended.
        if (reason === "PRECONDITION_FAILED") throw new BetNotSaved("ended");
        throw error;
      }
      const saved = weeklyBet(result);
      if (!saved) throw new Error("The saved goal could not be read.");
      return saved;
    },
    async createSteps(task, steps, requestId) {
      // Each step's task and request IDs are fixed once per add, so a retry creates none twice.
      const ids = sameAs(requestId, () =>
        steps.map(() => ({
          taskId: crypto.randomUUID(),
          requestId: crypto.randomUUID(),
        })),
      );
      const created: string[] = [];
      for (const [index, step] of steps.entries()) {
        const id = ids[index];
        if (!id) throw new Error("A step has no identity.");
        const saved = await tasks.createTask({
          ...id,
          task: {
            title: step.title,
            parentId: task.id,
            kind: "step",
            durationMinutes: step.estimatedMinutes ?? 0,
          },
        });
        created.push(saved.id);
      }
      built.delete(requestId);
      return created;
    },
    async updateLead(task, deadline, leadDays) {
      return save(task, ["deadline", "lead_days"], { deadline, leadDays });
    },
    async setDependencies(task, prerequisiteIds, added) {
      const write = (etag: string, ids: readonly string[]) =>
        tasks.updateTask({
          requestId: crypto.randomUUID(),
          etag,
          task: {
            name: `tasks/${task.id}`,
            dependencies: ids.map((id) => ({ prerequisiteId: id })),
          },
          updateMask: { paths: ["dependencies"] },
        });
      try {
        let etag = task.etag;
        // Tasks keeps a dependency the set already has, done or not: a done one starts over once
        // removed and added again, with the prerequisite's count then as its new baseline.
        if (added?.restart)
          etag = (
            await write(
              etag,
              prerequisiteIds.filter((id) => id !== added.id),
            )
          ).etag;
        const saved = await write(etag, prerequisiteIds);
        return {
          forTask: task.id,
          dependencies: taskDependencies(saved),
          task: planningTask(saved),
        };
      } catch (error) {
        throw added ? dependencyError(error) : error;
      }
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
      return timerSnapshot(await tasks.getFocusTimer({ name: "focusTimer" }));
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
          tasks.commandFocusTimer({
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
          tasks.createFocusEntry({
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
          tasks.updateFocusEntry({
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
        tasks.deleteFocusEntry({
          name: `focusEntries/${entry.id}`,
          etag: entry.etag,
          requestId,
        }),
      );
      return { deletedEntry: { id: entry.id, date: entry.date } };
    },
    async reorderTasks(ordered, movedId, lane, requestId) {
      // Built once per request ID from the tasks as Plan holds them, then resent as built.
      const request = sameAs(requestId, () => ({
        requestId,
        positions: UNTOUCHED_LANES.includes(lane)
          ? []
          : siblingPositions(ordered, movedId),
        ...(lane
          ? { laneOrder: { lane, taskIds: ordered.map((task) => task.id) } }
          : {}),
      }));
      let result;
      try {
        if (request.positions.length || request.laneOrder)
          result = await tasks.reorderTasks(request);
      } catch (error) {
        // Tasks refused it and wrote nothing: the next try is built from the tasks as they are then.
        if (error instanceof RpcStatusError) built.delete(requestId);
        throw error;
      }
      built.delete(requestId);
      return {
        reordered: (result?.tasks ?? []).map(planningTask),
        lane: result?.laneOrder && laneOrder(result.laneOrder),
      };
    },
  };
}
