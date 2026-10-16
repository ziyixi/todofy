import { holds } from "../src/dependencies";
import { BetNotSaved, betText, weeklyBet, withBets } from "../src/bets";
import { addDays } from "../src/domain";
import { apiPriority } from "../src/mail";
import { STAGE_ROLES } from "../src/planning-outcomes";
import type {
  FocusState,
  FlowDayPlan,
  MailCategories,
  MailItem,
  MailProject,
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
    dependencies: [],
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
        labels: ["lead_3d"],
        deadline: "2026-10-14",
        leadDays: 3,
        mustStart: true,
      }),
      task("passport", "Renew the passport", {
        area: "personal",
        labels: ["lead_1w"],
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
  // Todofy's mail: each mail task Mail Hero created, by task ID, and its summary by mail ID
  // (synthetic text only).
  const mail = new Map<string, MailItem>(
    [
      {
        id: "event-register",
        taskId: "mail-register",
        brief: "Registration is open; the early price ends Oct 20.",
        receivedAt: "2026-10-13T16:20:00Z",
        hasSummary: true,
      },
      {
        id: "event-notes",
        taskId: "mail-notes",
        brief: "Friday's shared notes were updated; add your part.",
        receivedAt: "2026-10-12T09:05:00Z",
        hasSummary: true,
      },
    ].map((item) => [item.taskId, item]),
  );
  const summaries: Record<string, string> = {
    "event-register":
      "Registration is open; the early price ends Oct 20.\n\n**Details**\n- The early price is 30% lower\n- Add dietary needs on the form",
    "event-notes": "Friday's shared notes were updated; add your part.",
  };
  let mailSettings: MailCategories = {
    categories: [],
    etag: "mail-0",
    destination: "",
  };
  const projects: MailProject[] = [
    { id: "synthetic-inbox", name: "Inbox", inbox: true },
    { id: "synthetic", name: "Synthetic projects", inbox: false },
  ];
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
      // As Todofy writes them: a stage's label replaces the other planning labels (the fixture's
      // label names are its roles), and in progress is the literal label, after which Todofy
      // lists the task neither as must start nor as missing a lead.
      const planning: string[] = Object.values(STAGE_ROLES);
      const staged = (task: PlanningTask): PlanningTask =>
        update.stage === undefined
          ? task
          : {
              ...task,
              labels: [
                ...task.labels.filter((label) => !planning.includes(label)),
                ...(update.stage === "none" ? [] : [STAGE_ROLES[update.stage]]),
              ],
            };
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
          task.id === item.id ? marked(staged({ ...task, ...update })) : task,
        ),
      };
      return structuredClone(plan.tasks.find((task) => task.id === item.id)!);
    },
    async setWeeklyBet(next) {
      // As Todofy answers SetWeeklyBet: the saved text is a replay, only this week and the next
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
    // As Todofy keeps them: by ID only, adding one that holds changing nothing and one that is done
    // starting it over (the limits are left out).
    async setDependency(taskId, prerequisiteId, waits) {
      const others = plan.dependencies.filter(
        (item) =>
          item.taskId !== taskId || item.prerequisiteId !== prerequisiteId,
      );
      const prerequisite = plan.tasks.find(
        (task) => task.id === prerequisiteId,
      );
      const existing = plan.dependencies.find(
        (item) =>
          item.taskId === taskId && item.prerequisiteId === prerequisiteId,
      );
      plan = {
        ...plan,
        dependencies: waits
          ? [
              ...others,
              existing && holds(existing, prerequisite)
                ? existing
                : {
                    taskId,
                    prerequisiteId,
                    baselineCount: prerequisite?.completedCount ?? 0,
                    done: false,
                  },
            ]
          : others,
      };
      return structuredClone({
        forTask: taskId,
        dependencies: plan.dependencies.filter(
          (item) => item.taskId === taskId,
        ),
      });
    },
    async resolveDependencies() {
      return structuredClone({ dependencies: plan.dependencies });
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
    async lookupMail(taskIds) {
      const items = taskIds.flatMap((id) => mail.get(id) ?? []);
      return structuredClone({ items, ...mailSettings });
    },
    async readMailSummary(id) {
      return summaries[id] ?? "";
    },
    async readMailSettings() {
      return structuredClone({ ...mailSettings, projects });
    },
    async updateMailSettings(categories, destination, etag) {
      // As Todofy answers: the saved settings are a replay; a category keeps its ID by its pair.
      const same =
        destination === mailSettings.destination &&
        JSON.stringify(categories) ===
          JSON.stringify(
            mailSettings.categories.map(({ labelId, priority }) => ({
              labelId,
              priority,
            })),
          );
      if (same) return structuredClone(mailSettings);
      if (etag !== mailSettings.etag)
        throw new Error("Synthetic categories changed");
      mailSettings = {
        categories: categories.map((category) => ({
          ...category,
          id:
            mailSettings.categories.find(
              (saved) =>
                saved.labelId === category.labelId &&
                saved.priority === category.priority,
            )?.id ?? crypto.randomUUID(),
        })),
        destination,
        etag: crypto.randomUUID(),
      };
      return structuredClone(mailSettings);
    },
    async fileMail(item, category, etag) {
      if (etag !== mailSettings.etag)
        throw new Error("Synthetic categories changed");
      const label = plan.availableLabels.find(
        (choice) => choice.id === category.labelId,
      )?.label;
      if (!label) throw new Error("Synthetic label gone");
      // The category's label; an area label replaces the other area label.
      const areas = { office: "work", home: "personal" } as const;
      const area = areas[label as keyof typeof areas];
      plan = {
        ...plan,
        tasks: plan.tasks.map((task) =>
          task.id === item.id
            ? {
                ...task,
                labels: [
                  ...task.labels.filter(
                    (name) => !(area && name in areas) && name !== label,
                  ),
                  label,
                ],
                area: area ?? task.area,
                priority: apiPriority(category.priority),
                projectId: mailSettings.destination,
              }
            : task,
        ),
      };
      return structuredClone(plan.tasks.find((task) => task.id === item.id)!);
    },
    async deleteMail(taskIds) {
      // Todofy's own check on its fresh read: only untouched mail tasks go.
      const deletable = (task: PlanningTask) =>
        mail.has(task.id) &&
        !task.labels.length &&
        task.priority === 1 &&
        !task.due &&
        !task.deadline;
      const deleted = plan.tasks
        .filter((task) => taskIds.includes(task.id) && deletable(task))
        .map((task) => task.id);
      plan = {
        ...plan,
        tasks: plan.tasks.filter((task) => !deleted.includes(task.id)),
      };
      return {
        deletedTaskIds: deleted,
        keptTaskIds: taskIds.filter((id) => !deleted.includes(id)),
      };
    },
  };
}
