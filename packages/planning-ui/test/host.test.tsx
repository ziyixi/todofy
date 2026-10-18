import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskEditor } from "../src/TaskEditor";
import { App as PlanningApp } from "../src/App";
import type { PlanningTask, PlusActions } from "../src/model";

afterEach(cleanup);
const task: PlanningTask = {
  id: "synthetic-step",
  title: "Write a short outline",
  parentId: "",
  projectId: "inbox",
  labels: [],
  area: "work",
  stage: "weekly",
  priority: 1,
  deadline: "",
  leadDays: 0,
  due: "",
  etag: "1",
  mustStart: false,
  missingLead: false,
};
it("opens the host task editor and names no other task app", () => {
  const open = vi.fn();
  render(
    <TaskEditor
      task={task}
      tasks={[task]}
      dependencies={[]}
      language="en"
      busy={false}
      actions={{} as PlusActions}
      run={vi.fn()}
      today="2026-10-17"
      todayTaskIds={[]}
      addFocus={vi.fn()}
      onOpenTask={open}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open task" }));
  expect(open).toHaveBeenCalledWith("synthetic-step");
  expect(document.body.textContent).not.toContain("Todoist");
});
it("refreshes the mounted native Focus after its host saves a task", async () => {
  const focus = {
    date: "2026-10-17",
    taskIds: [task.id],
    completedTaskIds: [],
    timerEtag: "timer",
    estimates: {},
    flowTasks: {},
  };
  const data: import("../src/model").PlusData = {
    plan: {
      tasks: [task],
      week: "2026-10-12",
      timezone: "UTC",
      configured: true,
      flowdayUrl: "",
      managedLabels: [],
      reviewTaskId: "",
      nextWeekTaskIds: [],
      dependencies: [],
      weeklyBets: [],
      laneOrders: {},
    },
    focus,
    days: [focus],
  };
  const load = vi.fn().mockResolvedValue(data);
  const actions = { load } as unknown as PlusActions;
  const props = {
    actions,
    view: "focus" as const,
    language: "en" as const,
    onOpenTask: vi.fn(),
    onSettings: vi.fn(),
  };
  const { rerender } = render(<PlanningApp {...props} refreshRevision={0} />);
  await screen.findByRole("button", { name: task.title });
  const mountedFocus = screen.getByRole("list", { name: "Today's steps" });
  load.mockResolvedValue({
    ...data,
    plan: {
      ...data.plan,
      tasks: [{ ...task, title: "Updated by the native editor" }],
    },
  });
  rerender(<PlanningApp {...props} refreshRevision={1} />);
  await screen.findByRole("button", { name: "Updated by the native editor" });
  expect(screen.queryByRole("button", { name: task.title })).toBeNull();
  expect(screen.getByRole("list", { name: "Today's steps" })).toBe(
    mountedFocus,
  );
  expect(load).toHaveBeenCalledTimes(2);
  rerender(<PlanningApp {...props} refreshRevision={1} />);
  expect(load).toHaveBeenCalledTimes(2);
});
