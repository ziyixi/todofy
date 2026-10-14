import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlanView } from "../src/PlanView";
import { TaskBreadcrumb } from "../src/TaskFamily";
import { taskAncestors } from "../src/domain";
import { createPrototype } from "../design/fixture";

afterEach(cleanup);

it("shows a commitment's small steps inline while counting only the outcome", async () => {
  const actions = createPrototype();
  const { plan, focus, days } = await actions.load();
  render(
    <PlanView
      plan={plan}
      days={days}
      flowTasks={focus.flowTasks}
      currentDate={focus.date}
      language="en"
      busy={false}
      actions={actions}
      run={vi.fn()}
      editTask={vi.fn()}
      onWeekChange={vi.fn()}
    />,
  );
  const pool = within(
    screen.getByRole("complementary", { name: "Outcomes and steps" }),
  );
  expect(pool.getByText("3 / 5")).toBeTruthy();
  expect(pool.getByText("Write the introduction")).toBeTruthy();
  expect(pool.getByText("Check the layout on a phone")).toBeTruthy();
  expect(
    pool.queryByLabelText("Drag to schedule: Ship the small website refresh"),
  ).toBeNull();
  expect(
    pool.getByLabelText("Drag to schedule: Write the introduction"),
  ).toBeTruthy();
});

it("schedules a leaf step to its chosen FlowDay date without changing Todoist planning or deadlines", async () => {
  const actions = createPrototype();
  const { plan, focus, days } = await actions.load();
  const before = structuredClone(plan.tasks);
  const move = vi.spyOn(actions, "moveTaskToDay");
  const update = vi.spyOn(actions, "updateTask");
  const lead = vi.spyOn(actions, "updateLead");
  render(
    <PlanView
      plan={plan}
      days={days}
      flowTasks={focus.flowTasks}
      currentDate={focus.date}
      language="en"
      busy={false}
      actions={actions}
      run={async (operation) => {
        await operation();
        return true;
      }}
      editTask={vi.fn()}
      onWeekChange={vi.fn()}
    />,
  );
  fireEvent.change(
    screen.getByLabelText("Schedule day: Check the layout on a phone"),
    { target: { value: "2026-10-15" } },
  );
  expect(move).toHaveBeenCalledWith(
    "layout",
    undefined,
    days.find((day) => day.date === "2026-10-15"),
  );
  expect(update).not.toHaveBeenCalled();
  expect(lead).not.toHaveBeenCalled();
  expect((await actions.load()).plan.tasks).toEqual(before);
});

it("keeps a child's full parent path visible in scheduled cards", async () => {
  const actions = createPrototype();
  const { plan } = await actions.load();
  const child = plan.tasks.find((task) => task.id === "copy")!;
  const nested = {
    ...child,
    id: "nested",
    title: "Polish one sentence",
    parentId: child.id,
  };
  const tasks = [...plan.tasks, nested];
  expect(taskAncestors(nested, tasks).map((task) => task.id)).toEqual([
    "release",
    "copy",
  ]);
  render(<TaskBreadcrumb task={nested} tasks={tasks} language="en" />);
  expect(screen.getByLabelText("Parent task").textContent).toBe(
    "Ship the small website refresh › Write the introduction",
  );
});

it("keeps a running step in its day until its session is stopped", async () => {
  const actions = createPrototype();
  const { plan, focus, days } = await actions.load();
  const timer = {
    taskId: "copy",
    flowDate: focus.date,
    status: "running" as const,
    elapsedSeconds: 60,
    startedAt: "2026-10-13T10:00:00Z",
    etag: "active",
  };
  render(
    <PlanView
      plan={plan}
      days={days}
      flowTasks={focus.flowTasks}
      timer={timer}
      currentDate={focus.date}
      language="en"
      busy={false}
      actions={actions}
      run={vi.fn()}
      editTask={vi.fn()}
      onWeekChange={vi.fn()}
    />,
  );
  for (const button of screen.getAllByRole("button", {
    name: "Drag to schedule: Write the introduction",
  }))
    expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(
    (
      screen.getByLabelText(
        "Schedule day: Write the introduction",
      ) as HTMLSelectElement
    ).disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "Remove from day: Write the introduction",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect((await actions.load()).focus.taskIds).toContain("copy");
});

it("navigates calendar weeks without relabelling the current commitments or locking navigation during a save", async () => {
  const actions = createPrototype();
  const { plan, focus, days } = await actions.load();
  const onWeekChange = vi.fn();
  const props = {
    plan,
    days,
    flowTasks: focus.flowTasks,
    currentDate: focus.date,
    language: "en" as const,
    busy: true,
    actions,
    run: vi.fn(),
    editTask: vi.fn(),
    onWeekChange,
  };
  const view = render(<PlanView {...props} />);
  const previous = screen.getByRole("button", { name: "Previous week" });
  const next = screen.getByRole("button", { name: "Next week" });
  expect((previous as HTMLButtonElement).disabled).toBe(false);
  expect((next as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(previous);
  fireEvent.click(next);
  expect(onWeekChange.mock.calls.map(([date]) => date)).toEqual([
    "2026-10-05",
    "2026-10-19",
  ]);
  const nextDays = days.map((day) => {
    const date = new Date(`${day.date}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + 7);
    return { ...day, date: date.toISOString().slice(0, 10) };
  });
  view.rerender(<PlanView {...props} days={nextDays} />);
  fireEvent.click(screen.getByRole("button", { name: "This week" }));
  expect(onWeekChange).toHaveBeenLastCalledWith("2026-10-12");
  expect(
    within(
      screen.getByRole("complementary", { name: "Outcomes and steps" }),
    ).getByText("3 / 5"),
  ).toBeTruthy();
});

it("marks steps from the same outcome consistently and distinguishes another outcome", async () => {
  const actions = createPrototype();
  const { plan, focus, days } = await actions.load();
  days[1]!.taskIds = ["copy", "layout", "outline", "missing-id"];
  render(
    <PlanView
      plan={plan}
      days={days}
      flowTasks={focus.flowTasks}
      currentDate={focus.date}
      language="en"
      busy={false}
      actions={actions}
      run={vi.fn()}
      editTask={vi.fn()}
      onWeekChange={vi.fn()}
    />,
  );
  const card = (id: string) =>
    document.querySelector<HTMLElement>(
      `.plus-week-step[data-task-id="${id}"]`,
    )!;
  expect(
    card("copy").querySelector('[aria-label="Parent task"]')?.textContent,
  ).toBe("Ship the small website refresh");
  expect(
    card("outline").querySelector('[aria-label="Parent task"]')?.textContent,
  ).toBe("Prepare the next research check-in");
  const color = (id: string) =>
    card(id).style.getPropertyValue("--plus-family-color");
  expect(color("copy")).toBe(color("layout"));
  expect(color("copy")).not.toBe(color("outline"));
  expect(card("missing-id").textContent).toContain("Task unavailable");
});
