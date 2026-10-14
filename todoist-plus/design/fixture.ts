import type {
  FocusState,
  FlowDayPlan,
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
  deadline: "",
  due: "",
  leadDays: 0,
  etag: "fixture",
  mustStart: false,
  missingLead: false,
  ...value,
});
export function createPrototype(): PlusActions {
  let plan: PlanState = {
    week: "2026-10-12",
    timezone: "America/Los_Angeles",
    configured: true,
    hiddenFilterIds: [],
    flowdayUrl: "https://flowday.example.test",
    managedLabelNames: [],
    managedLabels: [],
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
        deadline: "2026-10-16",
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
    ],
  };
  let focus: FocusState = {
    date: "2026-10-13",
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
  return {
    async load() {
      focus = { ...focus, ...days.find((day) => day.date === focus.date)! };
      return structuredClone({ plan, focus, days });
    },
    async updateTask(item, update) {
      plan = {
        ...plan,
        tasks: plan.tasks.map((task) =>
          task.id === item.id ? { ...task, ...update } : task,
        ),
      };
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
    async updateQueue(taskIds, target) {
      days = days.map((day) =>
        day.date === target.date ? { ...day, taskIds } : day,
      );
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
    },
    async updateEstimate(taskId, minutes) {
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
    },
  };
}
