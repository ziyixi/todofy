import type {
  FocusState,
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
    week: "Oct 12–18",
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
  return {
    async load() {
      return structuredClone({ plan, focus });
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
    async completeTask(item) {
      plan = {
        ...plan,
        tasks: plan.tasks.filter((task) => task.id !== item.id),
      };
      focus = {
        ...focus,
        completedTaskIds: [...focus.completedTaskIds, item.id],
        timer: focus.timer?.taskId === item.id ? undefined : focus.timer,
      };
    },
    async updateQueue(taskIds) {
      focus = { ...focus, taskIds };
    },
    async updateEstimate(taskId, minutes) {
      focus = {
        ...focus,
        estimates: { ...focus.estimates, [taskId]: minutes },
      };
    },
    async timer(action, taskId) {
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
                flowDate: focus.date,
                status: action === "pause" ? "paused" : "running",
                elapsedSeconds: seconds,
                startedAt: new Date().toISOString(),
                etag: crypto.randomUUID(),
              },
      };
    },
  };
}
