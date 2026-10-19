import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { PlanningTaskSchema } from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import { createPlanningActions, planningTask } from "../src/api";
import { hasPlanningFlag, isSchedulable } from "../src/domain";
import { canMarkActive, deadlineState } from "../src/deadlines";
import { canPark, isDateCandidate } from "../src/planning-outcomes";
import { withStage } from "../src/plan-updates";
import { boardLanes } from "../src/review-lanes";
import { quickTasks, waits } from "../src/weekly-review";
import { categoryLabels, touched } from "../src/mail";
import { TaskEditor } from "../src/TaskEditor";
import { WeeklyReview } from "../src/WeeklyReview";
import type {
  PlanState,
  PlanningTask,
  PlusActions,
  RunOperation,
} from "../src/model";

afterEach(cleanup);
const task: PlanningTask = {
  id: "synthetic",
  title: "Synthetic native action",
  parentId: "",
  projectId: "inbox",
  labels: ["quick", "active"],
  planningFlags: [],
  explicitStage: "none",
  area: "unassigned",
  stage: "none",
  priority: 1,
  deadline: "2026-10-17",
  due: "",
  leadDays: 1,
  etag: "1",
  mustStart: true,
  missingLead: false,
};
const plan: PlanState = {
  tasks: [task],
  nativePlanning: true,
  week: "2026-10-12",
  timezone: "UTC",
  configured: true,
  hiddenFilterIds: [],
  flowdayUrl: "",
  managedLabelNames: [],
  managedLabels: [],
  etag: "plan",
  availableLabels: [],
  inboxProjectId: "inbox",
  reviewTaskId: "",
  nextWeekTaskIds: [],
  dependencies: [],
  weeklyBets: [],
  laneOrders: {},
};

it("keeps ordinary tags separate from native planning flags, including an empty flag list", () => {
  const native = planningTask(
    create(PlanningTaskSchema, {
      id: task.id,
      labels: ["quick", "active"],
      explicitStage: "none",
    }),
  );
  expect(native.planningFlags).toEqual([]);
  expect(hasPlanningFlag(native, "active")).toBe(false);
  expect(quickTasks({ ...plan, tasks: [native] }, "2026-10-17")).toEqual([]);
  expect(hasPlanningFlag({ ...task, planningFlags: undefined }, "active")).toBe(
    true,
  );
  expect(deadlineState(task, "2026-10-17")?.kind).toBe("window");
  expect(canMarkActive(plan)).toBe(true);
  expect(canPark(plan)).toBe(true);
});

it("makes native Quick schedulable without requiring a separate standalone flag", () => {
  const quick = { ...task, kind: "task" as const, planningFlags: ["quick"] };
  expect(hasPlanningFlag(quick, "task")).toBe(true);
  expect(isSchedulable(quick)).toBe(true);
  expect(isSchedulable({ ...quick, planningFlags: [] })).toBe(false);
});

it("puts native states in the existing lanes and keeps tags unchanged on a stage drag", () => {
  const waiting = { ...task, id: "waiting", planningFlags: ["waiting"] };
  const parked = { ...task, id: "parked", planningFlags: ["parked"] };
  const quick = { ...task, id: "quick", planningFlags: ["quick"] };
  const lanes = boardLanes(
    { ...plan, tasks: [task, waiting, parked] },
    "2026-10-17",
  );
  expect(lanes.start.map((row) => row.id)).toEqual([task.id]);
  expect(lanes.waiting.map((row) => row.id)).toEqual([waiting.id]);
  expect(lanes.parked.map((row) => row.id)).toEqual([parked.id]);
  expect(waits(waiting)).toBe(true);
  expect(quickTasks({ ...plan, tasks: [quick] }, "2026-10-17")).toEqual([
    quick,
  ]);
  const moved = withStage(plan, task.id, "committed", true).tasks[0]!;
  expect(moved).toMatchObject({
    stage: "committed",
    explicitStage: "committed",
    planningFlags: ["active"],
    labels: task.labels,
  });
  const setAside = withStage(
    { ...plan, tasks: [moved] },
    task.id,
    "none",
    false,
    true,
  ).tasks[0]!;
  expect(setAside).toMatchObject({
    explicitStage: "none",
    planningFlags: ["parked"],
    labels: task.labels,
  });
  expect(
    isDateCandidate({ ...task, stage: "weekly", due: "2026-10-18" }, []),
  ).toBe(true);
  expect(
    isDateCandidate(
      { ...task, stage: "weekly", explicitStage: "weekly", due: "2026-10-18" },
      [],
    ),
  ).toBe(false);
});

it("keeps mail tasks with native planning choices out of bulk deletion", () => {
  const context = {
    tasks: [task],
    days: [],
    dependencies: [],
    pending: new Set<string>(),
    focus: {
      date: "2026-10-17",
      taskIds: [],
      completedTaskIds: [],
      timerEtag: "0",
      estimates: {},
      flowTasks: {},
    },
  };
  const untouched = {
    ...task,
    labels: [],
    deadline: "",
    mustStart: false,
    leadDays: 0,
  };
  expect(touched(untouched, context)).toBe(false);
  expect(touched({ ...untouched, explicitStage: "weekly" }, context)).toBe(
    true,
  );
  expect(touched({ ...untouched, planningFlags: ["waiting"] }, context)).toBe(
    true,
  );
});

it("edits native flags directly and shows saved stage rather than a date-derived stage", async () => {
  const updateTask = vi
    .fn()
    .mockResolvedValue({ ...task, planningFlags: ["quick"] });
  const run: RunOperation = async (operation) => {
    await operation();
    return true;
  };
  render(
    <TaskEditor
      destination={{
        name: "Tasks",
        taskHref: (id) => `/tasks/${id}`,
        projectHref: (id) => `/projects/${id}`,
      }}
      task={{ ...task, stage: "weekly" }}
      tasks={[task]}
      dependencies={[]}
      language="en"
      busy={false}
      actions={{ updateTask } as unknown as PlusActions}
      run={run}
      today="2026-10-17"
      todayTaskIds={[]}
      canMarkActive
      addFocus={vi.fn()}
      onOpenTask={vi.fn()}
    />,
  );
  const planning = screen.getByRole("combobox", { name: "Planning" });
  expect((planning as HTMLSelectElement).value).toBe("none");
  expect(
    within(planning.closest(".plus-editor-planning")!)
      .getByRole("button", { name: "Save" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(screen.getByText("Task options"));
  fireEvent.click(screen.getByRole("checkbox", { name: "Quick action" }));
  expect(updateTask).toHaveBeenCalledWith(
    expect.objectContaining({ id: task.id }),
    { quick: true },
  );
});

it("sends native flag writes in the existing update contract", async () => {
  const calls: import("@ziyixi/proto/http-client").HttpCall[] = [];
  const send: import("@ziyixi/proto/http-client").HttpSend = async (call) => {
    calls.push(call);
    return Response.json({
      task: {
        id: task.id,
        explicit_stage: "none",
        planning_flags: ["quick", "onhold"],
      },
    });
  };
  const actions = createPlanningActions(
    { plus: send, flowday: send },
    undefined,
    "tasks",
  );
  const updated = await actions.updateTask(task, { quick: true, onHold: true });
  expect(JSON.parse(calls[0]!.body!)).toMatchObject({
    quick: true,
    on_hold: true,
  });
  expect(updated.planningFlags).toEqual(["quick", "onhold"]);
  expect(updated.labels).toEqual([]);
});

it("offers ordinary native tags for optional mail shortcuts without interpreting their names as flags", () => {
  const ordinary = { id: "ordinary-active", label: "active" };
  expect(
    categoryLabels(
      { ...plan, availableLabels: [ordinary] },
      { work: "Work", personal: "Personal" },
    ),
  ).toEqual([{ id: ordinary.id, name: "active" }]);
  expect(hasPlanningFlag({ ...task, labels: ["active"] }, "active")).toBe(
    false,
  );
});

it("shows uncreated native Mail in weekly review and opens Mail without a task identity", () => {
  const openMail = vi.fn();
  const updateTask = vi.fn();
  render(
    <WeeklyReview
      plan={{ ...plan, tasks: [], inboxProjectId: "", mailboxPendingCount: 3 }}
      days={[]}
      today="2026-10-17"
      language="en"
      busy={false}
      run={vi.fn()}
      actions={{ updateTask } as unknown as PlusActions}
      editTask={vi.fn()}
      progress={{ lines: [], kept: [] }}
      onProgress={vi.fn()}
      onShowWaiting={vi.fn()}
      onPlanSteps={vi.fn()}
      completeReview={vi.fn()}
      onOpenMailbox={openMail}
      onClose={vi.fn()}
    />,
  );
  const line = screen.getByText("Mail to clarify").closest("li")!;
  expect(line.querySelector(".weekly-review-count")?.textContent).toBe("3");
  fireEvent.click(within(line).getByRole("button", { name: "Open" }));
  expect(openMail).toHaveBeenCalledTimes(1);
  expect(updateTask).not.toHaveBeenCalled();
});

it("schedules only explicit native steps or tasks deliberately marked standalone", async () => {
  const { outcomeSteps } = await import("../src/planning-outcomes");
  const root = { ...task, kind: "task" as const, stage: "committed" as const };
  const child = {
    ...root,
    id: "child",
    parentId: root.id,
    stage: "none" as const,
  };
  const step = {
    ...child,
    id: "step",
    parentId: child.id,
    kind: "step" as const,
  };
  expect(outcomeSteps(root, [root, child, step]).map((row) => row.id)).toEqual([
    step.id,
  ]);
  expect(
    outcomeSteps(root, [root, { ...child, planningFlags: ["task"] }, step]).map(
      (row) => row.id,
    ),
  ).toEqual([child.id, step.id]);
});

it("exposes native options without an independent blocked checkbox and accepts a custom lead", async () => {
  const { LeadSelect } = await import("../src/TaskEditor");
  const update = vi.fn();
  render(
    <LeadSelect
      value={21}
      language="en"
      disabled={false}
      label="Start ahead"
      customAllowed
      onChange={update}
    />,
  );
  fireEvent.change(screen.getByRole("spinbutton", { name: "Start ahead" }), {
    target: { value: "42" },
  });
  expect(update).toHaveBeenCalledWith(42);
  cleanup();
  render(
    <TaskEditor
      destination={{
        name: "Tasks",
        taskHref: (id) => `/tasks/${id}`,
        projectHref: (id) => `/projects/${id}`,
      }}
      task={{ ...task, kind: "task" }}
      tasks={[task]}
      dependencies={[]}
      language="en"
      busy={false}
      actions={{} as PlusActions}
      run={vi.fn()}
      today="2026-10-17"
      todayTaskIds={[]}
      canMarkActive={false}
      addFocus={vi.fn()}
      onOpenTask={vi.fn()}
    />,
  );
  expect(screen.getByRole("region", { name: "Task options" }).tagName).toBe(
    "SECTION",
  );
  expect(screen.queryByRole("checkbox", { name: "Blocked" })).toBeNull();
  expect(
    screen.getByRole("checkbox", { name: "Schedule as a step" }),
  ).toBeTruthy();
  const options = screen.getByRole("region", { name: "Task options" });
  expect(
    within(options)
      .getAllByRole("group")
      .map((group) => group.querySelector("legend")?.textContent),
  ).toEqual(["Action", "Status"]);
  expect(
    within(screen.getByRole("group", { name: "Action" }))
      .getAllByRole("checkbox")
      .map((input) => input.closest("label")?.textContent),
  ).toEqual(["Schedule as a step", "Quick action", "Routine"]);
  expect(
    within(screen.getByRole("group", { name: "Status" }))
      .getAllByRole("checkbox")
      .map((input) => input.closest("label")?.textContent),
  ).toEqual(["Waiting", "On hold"]);
});

it("keeps grouped native flags checked and disabled without local draft state", () => {
  const props = {
    destination: {
      name: "Tasks",
      taskHref: (id: string) => `/tasks/${id}`,
      projectHref: (id: string) => `/projects/${id}`,
    },
    task: {
      ...task,
      kind: "step" as const,
      planningFlags: ["quick", "waiting"],
    },
    tasks: [task],
    dependencies: [],
    language: "en" as const,
    busy: true,
    actions: {} as PlusActions,
    run: vi.fn(),
    today: "2026-10-17",
    todayTaskIds: [],
    canMarkActive: false,
    addFocus: vi.fn(),
    onOpenTask: vi.fn(),
  };
  const { rerender } = render(<TaskEditor {...props} />);
  expect(
    screen.queryByRole("checkbox", { name: "Schedule as a step" }),
  ).toBeNull();
  const quick = screen.getByRole("checkbox", {
    name: "Quick action",
  }) as HTMLInputElement;
  expect(quick.checked).toBe(true);
  expect(quick.disabled).toBe(true);
  expect(
    (screen.getByRole("checkbox", { name: "Waiting" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  rerender(
    <TaskEditor
      {...props}
      busy={false}
      task={{ ...props.task, planningFlags: ["routine"] }}
    />,
  );
  expect(quick.checked).toBe(false);
  expect(quick.disabled).toBe(false);
  expect(
    (screen.getByRole("checkbox", { name: "Routine" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  rerender(
    <TaskEditor
      {...props}
      busy={false}
      task={{ ...props.task, kind: "task", planningFlags: ["quick"] }}
    />,
  );
  const standalone = screen.getByRole("checkbox", {
    name: "Schedule as a step",
  }) as HTMLInputElement;
  expect(standalone.checked).toBe(true);
  expect(standalone.disabled).toBe(true);
});
