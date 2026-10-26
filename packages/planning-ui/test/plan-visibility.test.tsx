import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { PlanView, type PlanViewProps } from "../src/PlanView";
import { planVisibility } from "../src/plan-visibility";
import { boardLanes } from "../src/review-lanes";
import { createPrototype } from "./fixture";
import type { PlanningTask, PlusActions, PlusData } from "../src/model";

afterEach(cleanup);
function props(data: PlusData, actions: PlusActions): PlanViewProps {
  return {
    plan: data.plan,
    days: data.days,
    focusTasks: data.focus.tasks,
    currentDate: data.plan.today,
    language: "en",
    busy: false,
    actions,
    run: vi.fn(),
    editTask: vi.fn(),
    onWeekChange: vi.fn(),
    completeTask: vi.fn(),
    completeReview: vi.fn(),
  };
}

it("hides waiting flags, unfinished dependencies and descendants even when staged or manually parked", async () => {
  const data = await createPrototype().load();
  const task = (
    id: string,
    extra: Partial<PlanningTask> = {},
  ): PlanningTask => ({
    ...data.plan.tasks[0]!,
    id,
    title: `Synthetic ${id}`,
    kind: "task",
    stage: "monthly",
    explicitStage: "monthly",
    deadline: "",
    due: "",
    leadDays: 0,
    planningFlags: [],
    ...extra,
  });
  const plan = {
    ...data.plan,
    tasks: [
      task("available"),
      task("waiting", { planningFlags: ["waiting"] }),
      task("blocked", { planningFlags: ["blocked"] }),
      task("parked-waiting", {
        stage: "none",
        planningFlags: ["parked", "waiting"],
      }),
      task("dependent", { stage: "committed", explicitStage: "committed" }),
      task("child", {
        parentId: "dependent",
        kind: "step",
        deadline: "2026-10-14",
        mustStart: true,
      }),
      task("grandchild", { parentId: "child", planningFlags: ["quick"] }),
      task("prerequisite", { stage: "none", explicitStage: "none" }),
      task("manual-parked", {
        stage: "none",
        explicitStage: "none",
        planningFlags: ["parked"],
      }),
    ],
    dependencies: [
      { taskId: "dependent", prerequisiteId: "prerequisite", done: false },
    ],
  };
  const before = structuredClone(plan);
  const visible = planVisibility(plan);
  expect(visible.tasks.map((task) => task.id)).toEqual([
    "available",
    "prerequisite",
    "manual-parked",
  ]);
  expect(planVisibility(plan)).toBe(visible);
  const lanes = boardLanes(plan, plan.today);
  expect(lanes.waiting).toEqual([]);
  expect(
    Object.values(lanes)
      .flat()
      .map((task) => task.id),
  ).toEqual(["manual-parked", "available"]);
  expect(plan).toEqual(before);
});

it("surfaces the formerly hidden task in Parked after its final prerequisite is complete", async () => {
  const actions = createPrototype();
  const data = await actions.load();
  const dependent = data.plan.tasks.find((task) => task.id === "reading")!;
  const plan = {
    ...data.plan,
    dependencies: [
      { taskId: dependent.id, prerequisiteId: "tools", done: true },
      { taskId: dependent.id, prerequisiteId: "cleanup", done: false },
    ],
  };
  const before = structuredClone(dependent);
  const visit = props({ ...data, plan }, actions);
  const { rerender } = render(<PlanView {...visit} />);
  expect(
    screen.queryByRole("button", {
      name: /^Collect references for the next idea,/u,
    }),
  ).toBeNull();
  const completed = {
    ...plan,
    dependencies: plan.dependencies.map((edge) => ({ ...edge, done: true })),
  };
  rerender(<PlanView {...visit} plan={completed} />);
  expect(
    within(screen.getByRole("region", { name: "Parked" })).getByRole("button", {
      name: "Collect references for the next idea, Work, No priority, Prerequisites completed",
    }),
  ).toBeTruthy();
  expect(dependent).toEqual(before);
  expect(visit.run).not.toHaveBeenCalled();
});

it("filters Plan's commitments, steps, Quick and calendar while Focus keeps the original queued tasks", async () => {
  const actions = createPrototype();
  const data = await actions.load();
  data.plan.tasks = data.plan.tasks.map((task) => ({
    ...task,
    planningFlags:
      task.id === "release"
        ? ["waiting"]
        : task.id === "receipt"
          ? ["quick", "waiting"]
          : task.planningFlags,
  }));
  const today = data.days.find((day) => day.date === data.focus.date)!;
  today.completedTaskIds.push("past-step");
  data.focus.tasks["past-step"] = {
    title: "Synthetic hidden completed step",
    parentId: "release",
    parentTitle: "Ship the small website refresh",
    completed: true,
  };
  const before = structuredClone(data);
  vi.spyOn(actions, "load").mockResolvedValue(data);
  const update = vi.spyOn(actions, "updateTask");
  const move = vi.spyOn(actions, "moveTaskToDay");
  const common = {
    actions,
    language: "en" as const,
    onOpenTask: vi.fn(),
    onSettings: vi.fn(),
  };
  const visit = render(<App {...common} view="plan" />);
  await screen.findByRole("region", { name: "Parked" });
  expect(screen.queryByRole("region", { name: "Waiting" })).toBeNull();
  expect(
    screen.queryByRole("button", { name: /^Ship the small website refresh,/u }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  expect(
    document.querySelector('.planning-commitment [data-outcome-id="release"]'),
  ).toBeNull();
  expect(
    screen.queryByRole("region", {
      name: "Next steps: Ship the small website refresh",
    }),
  ).toBeNull();
  for (const id of ["copy", "layout", "receipt", "past-step"])
    expect(
      document.querySelector(`.planning-calendar [data-task-id="${id}"]`),
      id,
    ).toBeNull();
  expect(screen.queryByRole("region", { name: "Quick tasks" })).toBeNull();
  expect(screen.queryByText("Synthetic hidden completed step")).toBeNull();
  visit.rerender(<App {...common} view="focus" />);
  expect(
    await screen.findByRole("button", {
      name: "Start: Write the introduction",
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", {
      name: "Start: Download this month’s receipt",
    }),
  ).toBeTruthy();
  expect(data).toEqual(before);
  expect(update).not.toHaveBeenCalled();
  expect(move).not.toHaveBeenCalled();
});
