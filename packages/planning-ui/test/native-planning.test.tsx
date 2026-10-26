import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { create } from "@ziyixi/proto/protobuf";
import { TaskSchema } from "@ziyixi/proto/tasks/ui/v1/task_pb";
import { createPlanningActions, planningTask } from "../src/api";
import { hasPlanningFlag, isSchedulable } from "../src/domain";
import { deadlineState } from "../src/deadlines";
import { isDateCandidate } from "../src/planning-outcomes";
import { withStage } from "../src/plan-updates";
import { boardLanes } from "../src/review-lanes";
import { quickTasks, waits } from "../src/weekly-review";
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
  week: "2026-10-12",
  today: "2026-10-13",
  timezone: "UTC",
  nextWeekTaskIds: [],
  dependencies: [],
  weeklyBets: [],
  laneOrders: {},
};

it("keeps ordinary tags separate from planning flags, including an empty flag list", () => {
  const native = planningTask(
    create(TaskSchema, { id: task.id, labelIds: ["quick", "active"] }),
  );
  expect(native.planningFlags).toEqual([]);
  expect(native.explicitStage).toBe("none");
  expect(hasPlanningFlag(native, "active")).toBe(false);
  expect(quickTasks({ ...plan, tasks: [native] }, "2026-10-17")).toEqual([]);
  expect(deadlineState(task, "2026-10-17")?.kind).toBe("window");
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
  expect(lanes.start).toEqual([]);
  expect(lanes.waiting.map((row) => row.id)).toEqual([waiting.id]);
  expect(lanes.parked.map((row) => row.id)).toEqual([task.id, parked.id]);
  expect(waits(waiting)).toBe(true);
  expect(quickTasks({ ...plan, tasks: [quick] }, "2026-10-17")).toEqual([
    quick,
  ]);
  const moved = withStage(plan, task.id, "committed", true).tasks[0]!;
  expect(moved).toMatchObject({
    stage: "committed",
    explicitStage: "committed",
    planningFlags: ["active"],
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
  });
  expect(isDateCandidate({ ...task, stage: "weekly", due: "2026-10-18" })).toBe(
    true,
  );
  expect(
    isDateCandidate({
      ...task,
      stage: "weekly",
      explicitStage: "weekly",
      due: "2026-10-18",
    }),
  ).toBe(false);
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
      task={{ ...task, stage: "weekly" }}
      tasks={[task]}
      dependencies={[]}
      language="en"
      busy={false}
      actions={{ updateTask } as unknown as PlusActions}
      run={run}
      today="2026-10-17"
      todayTaskIds={[]}
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
  fireEvent.click(screen.getByRole("radio", { name: "Quick" }));
  expect(updateTask).toHaveBeenCalledWith(
    expect.objectContaining({ id: task.id }),
    { singleAction: true, quick: true },
  );
});

it("sends flag writes as the task's planning flags in one UpdateTask", async () => {
  const calls: import("@ziyixi/proto/http-client").HttpCall[] = [];
  const send: import("@ziyixi/proto/http-client").HttpSend = async (call) => {
    calls.push(call);
    return Response.json({
      id: task.id,
      name: `tasks/${task.id}`,
      stage: "none",
      planning_flags: ["quick", "onhold", "task"],
    });
  };
  const actions = createPlanningActions({ tasks: send });
  const updated = await actions.updateTask(task, { quick: true, onHold: true });
  expect(JSON.parse(calls[0]!.body!)).toEqual({
    planning_flags: ["quick", "onhold"],
  });
  expect(updated.planningFlags).toEqual(["quick", "onhold", "task"]);
});

it("shows uncreated native Mail in weekly review and opens Mail and GTD without a task identity", async () => {
  const openMail = vi.fn();
  const openGtd = vi.fn();
  const updateTask = vi.fn();
  render(
    <WeeklyReview
      plan={{ ...plan, tasks: [] }}
      days={[]}
      today="2026-10-17"
      language="en"
      busy={false}
      run={vi.fn()}
      actions={
        {
          updateTask,
          readWeeklyReview: async () => ({
            reviewTaskId: "",
            mailboxPendingCount: 3,
          }),
        } as unknown as PlusActions
      }
      editTask={vi.fn()}
      progress={{ lines: [], kept: [] }}
      onProgress={vi.fn()}
      onShowWaiting={vi.fn()}
      onPlanSteps={vi.fn()}
      completeReview={vi.fn()}
      onOpenMail={openMail}
      onOpenGtd={openGtd}
      onClose={vi.fn()}
    />,
  );
  const line = screen.getByText("Mail to clarify").closest("li")!;
  // Todofy's count arrives after the review opens; until then it shows "—".
  await waitFor(() =>
    expect(line.querySelector(".weekly-review-count")?.textContent).toBe("3"),
  );
  fireEvent.click(within(line).getByRole("button", { name: "Open" }));
  expect(openMail).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "GTD trends" }));
  expect(openGtd).toHaveBeenCalledTimes(1);
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

it("exposes execution and Routine without manual status controls and accepts a custom lead", async () => {
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
      task={{ ...task, kind: "task" }}
      tasks={[task]}
      dependencies={[]}
      language="en"
      busy={false}
      actions={{} as PlusActions}
      run={vi.fn()}
      today="2026-10-17"
      todayTaskIds={[]}
      addFocus={vi.fn()}
      onOpenTask={vi.fn()}
    />,
  );
  expect(
    within(screen.getByRole("radiogroup", { name: "Execution" }))
      .getAllByRole("radio")
      .map((input) => input.closest("label")?.textContent),
  ).toEqual(["Steps", "Standalone", "Quick"]);
  expect(screen.getByRole("switch", { name: "Routine" })).toBeTruthy();
  expect(screen.queryByRole("checkbox")).toBeNull();
  expect(screen.queryByRole("button", { name: /in progress/iu })).toBeNull();
});

it("follows saved execution and Routine, honors busy and leaves Step controls unchanged", () => {
  const props = {
    task: {
      ...task,
      kind: "task" as const,
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
    addFocus: vi.fn(),
    onOpenTask: vi.fn(),
  };
  const { rerender } = render(<TaskEditor {...props} />);
  const quick = screen.getByRole("radio", {
    name: "Quick",
  }) as HTMLInputElement;
  expect(quick.checked).toBe(true);
  expect(quick.disabled).toBe(true);
  expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(true);
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
    (screen.getByRole("switch", { name: "Routine" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(
    (screen.getByRole("radio", { name: "Steps" }) as HTMLInputElement).checked,
  ).toBe(true);
  rerender(
    <TaskEditor
      {...props}
      busy={false}
      task={{ ...props.task, kind: "task", planningFlags: ["quick"] }}
    />,
  );
  expect(quick.checked).toBe(true);
  expect(quick.disabled).toBe(false);
  rerender(<TaskEditor {...props} task={{ ...props.task, kind: "step" }} />);
  expect(screen.queryByRole("radiogroup")).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
});

it("switches Quick to Standalone or Steps atomically while Routine changes independently", () => {
  const updateTask = vi.fn().mockResolvedValue(task);
  const run: RunOperation = async (operation) => {
    await operation();
    return true;
  };
  const saved = {
    ...task,
    kind: "task" as const,
    planningFlags: [
      "quick",
      "active",
      "waiting",
      "onhold",
      "parked",
      "routine",
    ],
  };
  render(
    <TaskEditor
      task={saved}
      tasks={[saved]}
      dependencies={[]}
      language="en"
      busy={false}
      actions={{ updateTask } as unknown as PlusActions}
      run={run}
      today="2026-10-17"
      todayTaskIds={[]}
      addFocus={vi.fn()}
      onOpenTask={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("radio", { name: "Standalone" }));
  expect(updateTask).toHaveBeenLastCalledWith(saved, {
    singleAction: true,
    quick: false,
  });
  // Controls follow the server; an unconfirmed write leaves Quick selected.
  expect(
    (screen.getByRole("radio", { name: "Quick" }) as HTMLInputElement).checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Steps" }));
  expect(updateTask).toHaveBeenLastCalledWith(saved, {
    singleAction: false,
    quick: false,
  });
  fireEvent.click(screen.getByRole("switch", { name: "Routine" }));
  expect(updateTask).toHaveBeenLastCalledWith(saved, { routine: false });
});
