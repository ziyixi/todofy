import {
  createHttpClient,
  HttpResponseError,
  RpcStatusError,
} from "@ziyixi/proto/http-client";
import {
  PlusService,
  type LaneOrder as ApiLaneOrder,
  type MailCategory as ApiMailCategory,
  type Plan as ApiPlan,
  type PlanningTask as ApiPlanningTask,
  type TaskDependency as ApiTaskDependency,
  type Priority,
  type WeeklyBet as ApiWeeklyBet,
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
import { BET_AREAS, BetNotSaved } from "./bets";
import { MAIL_BATCH } from "./mail";
import type {
  BetArea,
  FlowDayPlan,
  FocusState,
  LaneId,
  MailCategories,
  MailCategory,
  MailLookup,
  PlanMetadata,
  PlanningTask,
  PlusActions,
  ReorderResult,
  TaskDependency,
  TimerSnapshot,
  WeeklyBet,
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
/** Todofy did not add a dependency; the message says why. */
class DependencyNotAddedError extends Error {}

export function publicError(error: unknown): string {
  if (
    error instanceof FlowdaySyncPendingError ||
    error instanceof DependencyNotAddedError
  )
    return error.message;
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
 * Todofy refuses a dependency the extension had allowed when another tab changed them meanwhile (a
 * cycle or the limit), and for reasons the same refusal also carries (Plus or Todoist paused or
 * blocked): the message names none of them. A task that is no longer active is said so.
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
/** The provider's ID in a reference: Todoist's today; empty for any other. */
function todoistId(ref: { provider: string; externalId: string } | undefined) {
  return ref?.provider === "todoist" ? ref.externalId : "";
}
function todoistRef(id: string) {
  return { provider: "todoist", externalId: id };
}
/** REQUIRED on the wire and ignored since protocol 6: filed mail always goes to the Inbox. */
const IGNORED_DESTINATION = "inbox";
function mailCategory(category: ApiMailCategory): MailCategory | undefined {
  const labelId = todoistId(category.label);
  // Priority's numbers are the domain's P1 (1) to P4 (4).
  if (!labelId || category.priority < 1 || category.priority > 4)
    return undefined;
  return { id: category.id, labelId, priority: category.priority };
}
function mailCategories(answer: {
  categories: ApiMailCategory[];
}): Omit<MailCategories, "etag"> {
  return {
    categories: answer.categories.flatMap(
      (category) => mailCategory(category) ?? [],
    ),
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
  // Every task the latest complete planning read listed: Todoist had them all, so FlowDay's next
  // manual sync imports them too, such as a second step added just before it.
  let plannedIds: string[] = [];
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
    // Read before the sync starts: a task listed only by a later read may be newer than it.
    const planned = plannedIds;
    for (let page = 0; page < 10; page++) {
      const result = await flowday.syncTasks({
        mode: SyncTasksRequest_Mode.MANUAL,
      });
      if (result.state === SyncTasksResponse_State.SYNCED) {
        await remember([...ids, ...planned]);
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
      if (!pageToken) {
        plannedIds = tasks.map((task) => task.id);
        return tasks;
      }
    }
    throw new Error("Task list is incomplete. Counts have not been shown.");
  }
  async function loadFlowTasks() {
    const estimates: Record<string, number> = {};
    const flowTasks: FocusState["flowTasks"] = {};
    let pageToken = "";
    // The gateway caps a FlowDay page at 100 tasks; FlowDay syncs at most 1,000 Todoist tasks plus local ones.
    for (let page = 0; page < 20; page++) {
      const result = await flowday.listTasks({ pageSize: 100, pageToken });
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
    async lookupMail(taskIds) {
      const lookup: MailLookup = { items: [], categories: [], etag: "" };
      const batches: string[][] = [];
      for (let start = 0; start < taskIds.length; start += MAIL_BATCH)
        batches.push(taskIds.slice(start, start + MAIL_BATCH));
      // At least one request: with no task to ask about, it still answers the categories.
      for (const batch of batches.length ? batches : [[]]) {
        const result = await plus.lookupMailItems({ taskIds: batch });
        lookup.items.push(
          ...result.items.flatMap((item) => {
            const taskId = todoistId(item.task);
            return taskId && item.receiveTime
              ? [
                  {
                    id: item.id,
                    taskId,
                    brief: item.brief,
                    receivedAt: new Date(
                      Number(item.receiveTime.seconds) * 1000,
                    ).toISOString(),
                    hasSummary: item.hasSummary,
                  },
                ]
              : [];
          }),
        );
        // The last answer's categories: the newest, should they change between requests.
        Object.assign(lookup, mailCategories(result), {
          etag: result.categoriesEtag,
        });
      }
      return lookup;
    },
    async readMailSummary(id) {
      return (await plus.readMailSummary({ id })).summary;
    },
    async readMailSettings() {
      const result = await plus.readMailSettings({});
      return { ...mailCategories(result), etag: result.etag };
    },
    async updateMailSettings(categories, etag) {
      const result = await plus.updateMailSettings({
        categories: categories.map((category) => ({
          label: todoistRef(category.labelId),
          priority: category.priority as Priority,
        })),
        destination: todoistRef(IGNORED_DESTINATION),
        etag,
      });
      return { ...mailCategories(result), etag: result.etag };
    },
    async fileMail(task, category, categoriesEtag, requestId) {
      // Without a category, Todofy only moves the task to the Inbox and ignores the categories'
      // etag, so none is sent: a later categories edit leaves the request as it was.
      const result = await plus.fileMailItem({
        taskId: task.id,
        etag: task.etag,
        requestId,
        categoryId: category?.id ?? "",
        categoriesEtag: category ? categoriesEtag : "",
      });
      if (!result.task) throw new Error("The filed task could not be read.");
      return {
        ...planningTask(result.task),
        estimatedMinutes: task.estimatedMinutes,
      };
    },
    async deleteMail(taskIds, requestId) {
      const result = await plus.deleteMailItems({ taskIds, requestId });
      return {
        deletedTaskIds: result.deletedTaskIds,
        keptTaskIds: result.keptTaskIds,
      };
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
