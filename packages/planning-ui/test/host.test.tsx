import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TaskEditor } from "../src/TaskEditor";
import { App as PlanningApp } from "../src/App";
import type { PlanningTask, PlusActions } from "../src/model";
import { createPrototype } from "./fixture";

afterEach(cleanup);
const task: PlanningTask = {
  id: "synthetic-step",
  title: "Write a short outline",
  parentId: "",
  projectId: "inbox",
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
    entries: [],
    timerEtag: "timer",
    estimates: {},
    tasks: {},
  };
  const data: import("../src/model").PlusData = {
    plan: {
      tasks: [task],
      week: "2026-10-12",
      today: "2026-10-17",
      timezone: "UTC",
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
it("retries a failed completion from another view with its first request ID and Focus day", async () => {
  const actions = createPrototype();
  // The introduction is queued today and, as well, on Monday.
  const load = actions.load;
  actions.load = async (week) => {
    const data = await load(week);
    data.days[0]!.taskIds.push("copy");
    return data;
  };
  const complete = vi
    .fn(actions.completeTask)
    .mockRejectedValueOnce(new Error("Connection interrupted"));
  actions.completeTask = complete;
  const props = {
    actions,
    language: "en" as const,
    onOpenTask: vi.fn(),
    onSettings: vi.fn(),
  };
  const name = "Complete task: Write the introduction";
  // First from Monday's card in Plan's calendar.
  const { rerender } = render(<PlanningApp {...props} view="plan" />);
  fireEvent.click(await screen.findByRole("tab", { name: "Week" }));
  fireEvent.click(
    document.querySelector<HTMLElement>(
      `.planning-calendar-day[data-date="2026-10-12"] [aria-label="${name}"]`,
    )!,
  );
  await screen.findByRole("alert");
  // Then from Focus, which would complete on today's queue.
  rerender(<PlanningApp {...props} view="focus" />);
  fireEvent.click(await screen.findByRole("button", { name }));
  await waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
  const [first, second] = complete.mock.calls;
  expect(first![2]).toBe("2026-10-12");
  expect([second![1], second![2]]).toEqual([first![1], first![2]]);
});
