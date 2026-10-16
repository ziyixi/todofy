import type {
  FocusState,
  FlowDayPlan,
  PlanMetadata,
  PlanState,
  PlanningTask,
  PlusActions,
} from "../src/model";
const task = (
  id: string,
  title: string,
  value: Partial<PlanningTask> = {},
): PlanningTask => ({
  id,
  title,
  parentId: "",
  projectId: "synthetic",
  labels: [],
  area: "work",
  stage: "none",
  bet: false,
  priority: 1,
  deadline: "",
  due: "",
  leadDays: 0,
  etag: "fixture",
  mustStart: false,
  missingLead: false,
  ...value,
});
export function createPrototype(
  fullBoard = false,
  today = "2026-10-13",
): PlusActions {
  const roles = [
    "office",
    "home",
    "bets",
    "committed",
    "focus",
    "candiate",
    "quarter",
    "lead_1d",
    "lead_3d",
    "lead_1w",
    "lead_2w",
    "lead_1m",
  ];
  let plan: PlanState = {
    week: "2026-10-12",
    timezone: "America/Los_Angeles",
    configured: true,
    hiddenFilterIds: [],
    flowdayUrl: "https://flowday.example.test",
    managedLabelNames: [...roles],
    managedLabels: roles.map((role) => ({
      role,
      id: `synthetic-${role}`,
      label: role,
    })),
    etag: "synthetic-plan-1",
    // The account's labels: the planning roles and the literal in-progress label.
    availableLabels: [...roles, "active"].map((role) => ({
      id: `synthetic-${role}`,
      label: role,
    })),
    inboxProjectId: "synthetic-mail",
    reviewTaskId: "weekly-review",
    nextWeekTaskIds: [],
    tasks: [
      task("release", "Ship the small website refresh", {
        stage: "committed",
        bet: true,
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
        bet: true,
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
        labels: ["quick"],
        estimatedMinutes: 15,
      }),
      // Weekly review data: waiting, someday and unclarified mail tasks, and the review task.
      task("venue", "Hear back about the venue quote", {
        labels: ["waiting", "office"],
        updatedAt: "2026-10-01T16:00:00Z",
      }),
      task("access", "Lab access approval", {
        labels: ["blocked", "office"],
        updatedAt: "2026-10-09T16:00:00Z",
      }),
      task("garden", "Plan a small balcony garden", {
        labels: ["parked", "home"],
        area: "personal",
        updatedAt: "2026-08-20T16:00:00Z",
      }),
      task("course", "Look into an evening course", {
        labels: ["onhold", "home"],
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
      bet: false,
      priority: item.id === "release" ? 4 : item.priority,
      parentId:
        item.id === "release"
          ? "work-goal"
          : item.id === "desk"
            ? "personal-goal"
            : item.parentId,
    }));
    plan.tasks.push(
      task("work-goal", "Make the next release easy to use", { bet: true }),
      task("personal-goal", "Create more room for a quiet weekend", {
        bet: true,
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
    );
  }
  let focus: FocusState = {
    date: today,
    timerEtag: "fixture",
    taskIds: ["copy", "outline", "receipt"],
    completedTaskIds: [],
    estimates: {},
    flowTasks: {},
  };
  let days: FlowDayPlan[] = Array.from({ length: 7 }, (_, index) => ({
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
  }));
  function weekDays(week: string) {
    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(`${week}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + index);
      const value = date.toISOString().slice(0, 10);
      const existing = days.find((day) => day.date === value);
      if (existing) return existing;
      const day = { date: value, taskIds: [], completedTaskIds: [] };
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
      return metadata as PlanMetadata;
    },
    async updateTask(item, { active, ...update }) {
      // In progress is the literal label; Todofy then lists the task neither as must start nor
      // as missing a lead.
      const marked = (task: PlanningTask): PlanningTask =>
        active === undefined
          ? task
          : {
              ...task,
              labels: [
                ...task.labels.filter((label) => label !== "active"),
                ...(active ? ["active"] : []),
              ],
              ...(active ? { mustStart: false, missingLead: false } : {}),
            };
      plan = {
        ...plan,
        tasks: plan.tasks.map((task) =>
          task.id === item.id ? marked({ ...task, ...update }) : task,
        ),
      };
      return structuredClone(plan.tasks.find((task) => task.id === item.id)!);
    },
    async updateLabels(labels, etag) {
      if (etag !== plan.etag) throw new Error("Synthetic mapping changed");
      const managedLabels = [
        ...plan.managedLabels.filter(
          (binding) =>
            !["quarter", "candiate", "focus", "committed"].includes(
              binding.role,
            ),
        ),
        ...labels,
      ];
      plan = {
        ...plan,
        managedLabels,
        managedLabelNames: managedLabels.map((binding) => binding.label),
        etag: crypto.randomUUID(),
      };
      const metadata: Partial<PlanState> = structuredClone(plan);
      delete metadata.tasks;
      return metadata as PlanMetadata;
    },
    async createSteps(item, drafts) {
      plan = {
        ...plan,
        tasks: [
          ...plan.tasks,
          ...drafts.map((draft) =>
            task(crypto.randomUUID(), draft.title, {
              parentId: item.id,
              area: item.area,
              estimatedMinutes: draft.estimatedMinutes,
            }),
          ),
        ],
      };
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
    async completeTask(item, _requestId, flowDate) {
      plan = {
        ...plan,
        tasks: plan.tasks.filter((task) => task.id !== item.id),
      };
      focus = {
        ...focus,
        timer: focus.timer?.taskId === item.id ? undefined : focus.timer,
      };
      days = days.map((day) =>
        day.date === flowDate
          ? {
              ...day,
              completedTaskIds: [
                ...new Set([...day.completedTaskIds, item.id]),
              ],
            }
          : day,
      );
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
    async updateEstimate(taskId, minutes) {
      plan = {
        ...plan,
        tasks: plan.tasks.map((task) =>
          task.id === taskId
            ? { ...task, estimatedMinutes: minutes > 0 ? minutes : undefined }
            : task,
        ),
      };
      focus = {
        ...focus,
        estimates: { ...focus.estimates, [taskId]: minutes },
      };
    },
    async timer(action, taskId, target) {
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
                flowDate:
                  action === "start"
                    ? target.date
                    : (focus.timer?.flowDate ?? target.date),
                status: action === "pause" ? "paused" : "running",
                elapsedSeconds: seconds,
                startedAt: new Date().toISOString(),
                etag: crypto.randomUUID(),
              },
      };
      return { timerEtag: focus.timerEtag, timer: focus.timer };
    },
  };
}
