import { BetNotSaved, betText, weeklyBet, withBets } from "../src/bets";
import { addDays } from "../src/domain";
import { withLaneOrder } from "../src/plan-updates";
import type {
  DayPlan,
  FocusEntry,
  FocusState,
  FocusTaskInfo,
  PlanMetadata,
  PlanState,
  PlanUpdate,
  PlanningTask,
  PlusActions,
} from "../src/model";
/** A task as Tasks lists it: its saved stage and planning flags. */
const task = (
  id: string,
  title: string,
  value: Partial<PlanningTask> = {},
): PlanningTask => ({
  id,
  title,
  parentId: "",
  projectId: "synthetic",
  planningFlags: [],
  area: "work",
  stage: "none",
  priority: 1,
  deadline: "",
  due: "",
  leadDays: 0,
  etag: "fixture",
  mustStart: false,
  missingLead: false,
  ...value,
  explicitStage: value.explicitStage ?? value.stage ?? "none",
});
/** The planning flags the plan switches set (Task.planning_flags in Tasks). */
const FLAGS: Partial<Record<keyof PlanUpdate, string>> = {
  quick: "quick",
  waiting: "waiting",
  routine: "routine",
  onHold: "onhold",
  blocked: "blocked",
  singleAction: "task",
};
export function createPrototype(
  fullBoard = false,
  today = "2026-10-13",
): PlusActions {
  let plan: PlanState = {
    week: "2026-10-12",
    today,
    timezone: "America/Los_Angeles",
    nextWeekTaskIds: [],
    dependencies: [],
    laneOrders: {},
    // This week's Work Bet; the Personal one is empty, so last week's is offered to keep.
    weeklyBets: [
      {
        weekStart: "2026-10-05",
        area: "personal",
        text: "A quiet, unhurried weekend",
        etag: "1",
      },
      {
        weekStart: "2026-10-12",
        area: "work",
        text: "Get the website refresh ready for review",
        etag: "2",
      },
    ],
    tasks: [
      task("release", "Ship the small website refresh", {
        stage: "committed",
        deadline: "2026-10-23",
        leadDays: 7,
      }),
      task("copy", "Write the introduction", {
        parentId: "release",
        estimatedMinutes: 30,
      }),
      task("layout", "Check the layout on a phone", {
        parentId: "release",
        estimatedMinutes: 45,
      }),
      task("research", "Prepare the next research check-in", {
        stage: "committed",
        deadline: "2026-10-15",
        leadDays: 3,
        mustStart: true,
      }),
      task("outline", "Outline three questions for the check-in", {
        parentId: "research",
        estimatedMinutes: 60,
      }),
      task("notes", "Organize the experiment notes", { stage: "committed" }),
      task("cleanup", "Clear out the old development branch", {
        stage: "weekly",
      }),
      task("tools", "Try the new charting library", { stage: "weekly" }),
      task("reading", "Collect references for the next idea", {
        stage: "monthly",
      }),
      task("desk", "Make the home desk comfortable", {
        stage: "committed",
        area: "personal",
      }),
      task("measure", "Measure the desk for a new lamp", {
        parentId: "desk",
        area: "personal",
        estimatedMinutes: 15,
      }),
      task("walk", "Choose a trail for the weekend", {
        stage: "weekly",
        area: "personal",
      }),
      task("receipt", "Download this month’s receipt", {
        planningFlags: ["quick"],
        estimatedMinutes: 15,
      }),
      // Weekly review data: waiting, someday and unclarified mail tasks, and the review task.
      task("venue", "Hear back about the venue quote", {
        planningFlags: ["waiting"],
        updatedAt: "2026-10-01T16:00:00Z",
      }),
      task("access", "Lab access approval", {
        planningFlags: ["blocked"],
        updatedAt: "2026-10-09T16:00:00Z",
      }),
      task("garden", "Plan a small balcony garden", {
        planningFlags: ["parked"],
        area: "personal",
        updatedAt: "2026-08-20T16:00:00Z",
      }),
      task("course", "Look into an evening course", {
        planningFlags: ["onhold"],
        area: "personal",
        updatedAt: "2026-09-12T16:00:00Z",
      }),
      task("mail-register", "Fwd: Conference registration opens", {
        projectId: "synthetic-mail",
        area: "unassigned",
      }),
      task("mail-notes", "Re: Shared notes for Friday", {
        projectId: "synthetic-mail",
        area: "unassigned",
      }),
      task("weekly-review", "Weekly review 2026-W42", {
        projectId: "synthetic-mail",
        area: "unassigned",
      }),
    ],
  };
  if (fullBoard) {
    plan.tasks = plan.tasks.map((item) => ({
      ...item,
      priority: item.id === "release" ? 4 : item.priority,
      parentId:
        item.id === "release"
          ? "work-goal"
          : item.id === "desk"
            ? "personal-goal"
            : item.parentId,
      // A waiting task with its deadline.
      ...(item.id === "venue" ? { deadline: "2026-10-22" } : {}),
    }));
    plan.tasks.push(
      task("work-goal", "Make the next release easy to use"),
      task("personal-goal", "Create more room for a quiet weekend", {
        area: "personal",
      }),
      task("quarter-idea", "Simplify the research workspace", {
        stage: "quarterly",
      }),
      task("month-idea", "Set up a small reading corner", {
        stage: "monthly",
        area: "personal",
      }),
      task("paper", "Finish the experiment outline", { stage: "committed" }),
      task("paper-step", "Sketch the first comparison", {
        parentId: "paper",
        estimatedMinutes: 45,
      }),
      task("review", "Review the current data pipeline", {
        stage: "committed",
      }),
      task("review-step", "List the two simplest improvements", {
        parentId: "review",
        estimatedMinutes: 30,
      }),
      task("trip", "Plan a short weekend walk", {
        stage: "committed",
        area: "personal",
      }),
      task("trip-step", "Choose a meeting point", {
        parentId: "trip",
        area: "personal",
        estimatedMinutes: 15,
      }),
      task("home", "Clear a shelf for the new books", {
        stage: "committed",
        area: "personal",
      }),
      task("home-step", "Sort one shelf", {
        parentId: "home",
        area: "personal",
        estimatedMinutes: 30,
      }),
      // Start now: in the start window, and past the deadline.
      task("claim", "Submit the travel expense claim", {
        deadline: "2026-10-14",
        leadDays: 3,
        mustStart: true,
      }),
      task("passport", "Renew the passport", {
        area: "personal",
        deadline: "2026-10-11",
        leadDays: 7,
        mustStart: true,
      }),
      // A deadline without a start-ahead choice: only the weekly review's line.
      task("insurance", "Renew the car insurance", {
        area: "personal",
        deadline: "2026-11-30",
        missingLead: true,
      }),
    );
  }
  // Todoist's position of each task among its siblings, in the order listed here.
  const siblings = new Map<string, number>();
  plan.tasks = plan.tasks.map((item) => {
    const group = `${item.projectId}|${item.parentId}`;
    const childOrder = (siblings.get(group) ?? 0) + 1;
    siblings.set(group, childOrder);
    return { ...item, childOrder };
  });
  let focus: FocusState = {
    date: today,
    timerEtag: "fixture",
    taskIds: ["copy", "outline", "receipt"],
    completedTaskIds: [],
    entries: [],
    estimates: {},
    tasks: {},
  };
  let days: DayPlan[] = Array.from({ length: 7 }, (_, index) => ({
    date: `2026-10-${12 + index}`,
    taskIds:
      index === 0
        ? ["layout"]
        : index === 1
          ? [...focus.taskIds]
          : index === 2
            ? ["cleanup"]
            : [],
    completedTaskIds: [],
    entries: [],
  }));
  function weekDays(week: string) {
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(`${week}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + index);
      const value = date.toISOString().slice(0, 10);
      const existing = days.find((day) => day.date === value);
      if (existing) return existing;
      const day = {
        date: value,
        taskIds: [],
        completedTaskIds: [],
        entries: [],
      };
      days = [...days, day];
      return day;
    });
  }
  return {
    async load(week = plan.week) {
      focus = { ...focus, ...days.find((day) => day.date === focus.date)! };
      return structuredClone({ plan, focus, days: weekDays(week) });
    },
    async loadDays(week) {
      return structuredClone(weekDays(week));
    },
    async readPlan() {
      const metadata: Partial<PlanState> = structuredClone(plan);
      delete metadata.tasks;
      delete metadata.dependencies;
      return metadata as PlanMetadata;
    },
    // Todofy's weekly review facts: two pending mails and this week's review task.
    async readWeeklyReview() {
      return { reviewTaskId: "weekly-review", mailboxPendingCount: 2 };
    },
    async updateTask(item, { stage, area, active, parked, ...switches }) {
      // As Tasks saves planning state: the stage is the saved stage, and each switch sets
      // or clears its flag. In progress clears must start and missing lead; setting aside comes
      // last, with no stage and not in progress.
      const saved = (task: PlanningTask): PlanningTask => {
        const flags = new Set(task.planningFlags);
        for (const [field, flag] of Object.entries(FLAGS)) {
          const on = switches[field as keyof typeof switches];
          if (on !== undefined && flag) {
            if (on) flags.add(flag);
            else flags.delete(flag);
          }
        }
        if (active !== undefined) {
          if (active) flags.add("active");
          else flags.delete("active");
        }
        if (parked !== undefined) {
          if (parked) {
            flags.add("parked");
            flags.delete("active");
          } else flags.delete("parked");
        }
        const next = parked ? "none" : (stage ?? task.explicitStage ?? "none");
        return {
          ...task,
          ...(area ? { area } : {}),
          stage: stage === undefined && !parked ? task.stage : next,
          explicitStage: next,
          planningFlags: [...flags],
          ...(active ? { mustStart: false, missingLead: false } : {}),
        };
      };
      plan = {
        ...plan,
        tasks: plan.tasks.map((task) =>
          task.id === item.id ? saved(task) : task,
        ),
      };
      return structuredClone(plan.tasks.find((task) => task.id === item.id)!);
    },
    async setWeeklyBet(next) {
      // As Tasks answers UpdateWeeklyBet: the saved text is a replay, only this week and the next
      // take a write, and only from the etag shown.
      const text = betText(next.text);
      const saved = weeklyBet(plan.weeklyBets, next.weekStart, next.area);
      if (saved.text === text) return structuredClone(saved);
      if (![plan.week, addDays(plan.week, 7)].includes(next.weekStart))
        throw new BetNotSaved("ended");
      if (next.etag !== saved.etag) throw new BetNotSaved("changed");
      const bet = { ...saved, text, etag: String(Number(saved.etag || 0) + 1) };
      plan = { ...plan, weeklyBets: withBets(plan.weeklyBets, [bet]) };
      return structuredClone(bet);
    },
    async createSteps(item, drafts) {
      // As Todoist appends sub-tasks: after the parent's other children.
      const last = Math.max(
        0,
        ...plan.tasks
          .filter((task) => task.parentId === item.id)
          .map((task) => task.childOrder ?? 0),
      );
      const created = drafts.map((draft, index) =>
        task(crypto.randomUUID(), draft.title, {
          parentId: item.id,
          projectId: item.projectId,
          area: item.area,
          estimatedMinutes: draft.estimatedMinutes,
          childOrder: last + index + 1,
        }),
      );
      plan = { ...plan, tasks: [...plan.tasks, ...created] };
      return created.map((step) => step.id);
    },
    async updateLead(item, deadline, leadDays) {
      plan = {
        ...plan,
        tasks: plan.tasks.map((task) =>
          task.id === item.id ? { ...task, deadline, leadDays } : task,
        ),
      };
      return structuredClone(plan.tasks.find((task) => task.id === item.id)!);
    },
    async completeTask(item, _requestId, focusDay) {
      // As Tasks settles a completion: a related session's day, else the given day or today.
      const settled =
        focus.timer?.taskId === item.id ? focus.timer.day : focusDay || today;
      plan = {
        ...plan,
        tasks: plan.tasks.filter((task) => task.id !== item.id),
      };
      // Tasks' Focus read still names it, now completed, with its title and parent.
      const parent = plan.tasks.find((task) => task.id === item.parentId);
      focus = {
        ...focus,
        timer: focus.timer?.taskId === item.id ? undefined : focus.timer,
        tasks: {
          ...focus.tasks,
          [item.id]: {
            title: item.title,
            parentId: item.parentId,
            parentTitle: parent?.title ?? "",
            ...(item.estimatedMinutes
              ? { estimatedMinutes: item.estimatedMinutes }
              : {}),
            completed: true,
          },
        },
      };
      days = days.map((day) =>
        day.date === settled && day.taskIds.includes(item.id)
          ? {
              ...day,
              taskIds: day.taskIds.filter((id) => id !== item.id),
              completedTaskIds: [...day.completedTaskIds, item.id],
            }
          : day,
      );
    },
    // As Tasks keeps the set, by ID: one it has stays as it is, done or not, unless `added`
    // restarts it, and a new one holds (the limits are left out).
    async setDependencies(item, prerequisiteIds, added) {
      const own = plan.dependencies.filter((other) => other.taskId === item.id);
      const saved = prerequisiteIds.map((id) => {
        const kept = own.find((other) => other.prerequisiteId === id);
        return kept && !(added?.restart && added.id === id)
          ? kept
          : { taskId: item.id, prerequisiteId: id, done: false };
      });
      plan = {
        ...plan,
        dependencies: [
          ...plan.dependencies.filter((other) => other.taskId !== item.id),
          ...saved,
        ],
      };
      return structuredClone({ forTask: item.id, dependencies: saved });
    },
    async addToDay(id, date) {
      days = days.map((day) =>
        day.date === date && !day.taskIds.includes(id)
          ? { ...day, taskIds: [...day.taskIds, id] }
          : day,
      );
      return structuredClone(days.filter((day) => day.date === date));
    },
    async removeFromDay(id, date) {
      days = days.map((day) =>
        day.date === date
          ? { ...day, taskIds: day.taskIds.filter((value) => value !== id) }
          : day,
      );
      return structuredClone(days.filter((day) => day.date === date));
    },
    async moveTaskToDay(id, source, target, beforeId) {
      days = days.map((day) => {
        if (day.date === target.date) {
          const taskIds = day.taskIds.filter((value) => value !== id);
          const before = beforeId ? taskIds.indexOf(beforeId) : -1;
          taskIds.splice(before < 0 ? taskIds.length : before, 0, id);
          return { ...day, taskIds };
        }
        return source?.date === day.date
          ? { ...day, taskIds: day.taskIds.filter((value) => value !== id) }
          : day;
      });
      return structuredClone(
        days.filter(
          (day) => day.date === target.date || day.date === source?.date,
        ),
      );
    },
    async updateEstimate(item, minutes) {
      // A write of the task: its etag changes.
      const etag = crypto.randomUUID();
      plan = {
        ...plan,
        tasks: plan.tasks.map((task) =>
          task.id === item.id
            ? {
                ...task,
                estimatedMinutes: minutes > 0 ? minutes : undefined,
                etag,
              }
            : task,
        ),
      };
      focus = {
        ...focus,
        estimates: { ...focus.estimates, [item.id]: minutes },
      };
      return { estimate: { taskId: item.id, minutes }, etag };
    },
    async timer(action, taskId, _focus, _targetSeconds, area = "unassigned") {
      const seconds = focus.timer
        ? focus.timer.elapsedSeconds +
          (focus.timer.status === "running"
            ? Math.floor(
                (Date.now() - Date.parse(focus.timer.startedAt)) / 1000,
              )
            : 0)
        : 0;
      focus = {
        ...focus,
        timerEtag: crypto.randomUUID(),
        timer:
          action === "stop"
            ? undefined
            : {
                taskId,
                // Start counts on Tasks' today.
                day: action === "start" ? today : (focus.timer?.day ?? today),
                area: action === "start" ? area : (focus.timer?.area ?? area),
                status: action === "pause" ? "paused" : "running",
                elapsedSeconds: seconds,
                startedAt: new Date().toISOString(),
                etag: crypto.randomUUID(),
              },
      };
      return { timerEtag: focus.timerEtag, timer: focus.timer };
    },
    async readFocus(start, end) {
      const range: DayPlan[] = [];
      for (let date = start; date <= end; date = addDays(date, 1)) {
        let day = days.find((item) => item.date === date);
        if (!day) {
          day = { date, taskIds: [], completedTaskIds: [], entries: [] };
          days = [...days, day];
        }
        range.push(day);
      }
      // As Tasks reads them: every task the queues and records name, with its parent's title.
      const named = new Set(
        range.flatMap((day) => [
          ...day.taskIds,
          ...day.completedTaskIds,
          ...day.entries.map((entry) => entry.taskId),
        ]),
      );
      const tasks: Record<string, FocusTaskInfo> = {};
      for (const id of named) {
        const item = plan.tasks.find((task) => task.id === id);
        const parent = plan.tasks.find((task) => task.id === item?.parentId);
        const info = item
          ? {
              title: item.title,
              parentId: item.parentId,
              parentTitle: parent?.title ?? "",
              ...(item.estimatedMinutes
                ? { estimatedMinutes: item.estimatedMinutes }
                : {}),
              completed: false,
            }
          : focus.tasks[id];
        if (info) tasks[id] = info;
      }
      return structuredClone({ days: range, tasks, today });
    },
    async addEntry(entry) {
      const saved: FocusEntry = {
        ...entry,
        id: crypto.randomUUID(),
        source: "manual",
        etag: "1",
      };
      days = days.map((day) =>
        day.date === saved.date
          ? { ...day, entries: [...day.entries, saved] }
          : day,
      );
      return structuredClone({ savedEntry: saved });
    },
    async updateEntry(entry, seconds) {
      const saved = {
        ...entry,
        seconds,
        etag: String(Number(entry.etag) + 1),
      };
      days = days.map((day) => ({
        ...day,
        entries: day.entries.map((item) =>
          item.id === entry.id ? saved : item,
        ),
      }));
      return structuredClone({ savedEntry: saved });
    },
    async deleteEntry(entry) {
      days = days.map((day) => ({
        ...day,
        entries: day.entries.filter((item) => item.id !== entry.id),
      }));
      return { deletedEntry: { id: entry.id, date: entry.date } };
    },
    async reorderTasks(ordered, movedId, lane) {
      // As Tasks reorders: the moved task's siblings among these take their existing positions in
      // this order (never in Waiting or Parked), and the lane keeps the order of those still active.
      const listed = ordered.flatMap(
        (item) => plan.tasks.find((task) => task.id === item.id) ?? [],
      );
      const moved = listed.find((task) => task.id === movedId);
      const group = listed.filter(
        (task) =>
          task.projectId === moved?.projectId &&
          task.parentId === moved?.parentId,
      );
      const orders = group.map((task) => task.childOrder ?? NaN);
      if (
        lane !== "waiting" &&
        lane !== "parked" &&
        orders.every(Number.isInteger) &&
        new Set(orders).size === orders.length
      ) {
        const sorted = [...orders].sort((a, b) => a - b);
        const positions = new Map(
          group.map((task, index) => [task.id, sorted[index]]),
        );
        plan = {
          ...plan,
          tasks: plan.tasks.map((task) =>
            positions.has(task.id)
              ? { ...task, childOrder: positions.get(task.id) }
              : task,
          ),
        };
      }
      const ids = listed.map((task) => task.id);
      if (lane) plan = withLaneOrder(plan, lane, ids);
      return structuredClone({
        reordered: ids.map((id) => plan.tasks.find((task) => task.id === id)!),
        ...(lane ? { lane: { lane, taskIds: ids } } : {}),
      });
    },
  };
}
