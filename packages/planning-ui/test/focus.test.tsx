import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createPrototype } from "./fixture";
import { FocusView } from "../src/FocusView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("shows cleaned parent context, and a task Plan does not list from Tasks' read, with execution controls only", async () => {
  const { plan, focus } = await createPrototype().load();
  const parent = plan.tasks.find((task) => task.id === "release")!;
  parent.title = "[TASK] Synthetic outcome <k:synthetic.root>";
  plan.tasks.push({
    ...parent,
    id: "phase",
    parentId: parent.id,
    title: "[TASK] Synthetic phase <k:synthetic.phase>",
    stage: "none",
  });
  const child = plan.tasks.find((task) => task.id === "copy")!;
  child.parentId = "phase";
  child.title = "[TASK] Synthetic leaf <k:synthetic.leaf>";
  focus.taskIds.push("unlisted");
  focus.tasks["unlisted"] = {
    title: "Synthetic unlisted step",
    parentId: "elsewhere",
    parentTitle: "[TASK] Synthetic other outcome",
    estimatedMinutes: 15,
    completed: false,
  };
  const onTimer = vi.fn();
  const complete = vi.fn();
  render(
    <FocusView
      plan={plan}
      focus={focus}
      language="en"
      busy={false}
      editTask={vi.fn()}
      complete={complete}
      onOpenPlan={vi.fn()}
      onTimer={onTimer}
    />,
  );
  const context = screen.getByText("Synthetic outcome", { exact: true });
  expect(context.getAttribute("title")).toBe(
    "Synthetic outcome › Synthetic phase",
  );
  expect(screen.getByText("Synthetic leaf", { exact: true })).toBeTruthy();
  expect(screen.queryByText(/\[TASK\]|<k:/)).toBeNull();
  expect(
    screen.getByText("Synthetic unlisted step", { exact: true }),
  ).toBeTruthy();
  expect(
    screen.getByText("Synthetic other outcome", { exact: true }),
  ).toBeTruthy();
  expect(
    document.querySelector('[data-task-id="unlisted"] .plus-focus-estimate')!
      .textContent,
  ).toBe("15m");
  expect(
    screen.queryByRole("button", {
      name: "Complete task: Synthetic unlisted step",
    }),
  ).toBeNull();
  expect(
    screen.queryByRole("button", {
      name: /Choose tasks|Drag step|Remove from day|Move up|Move down/,
    }),
  ).toBeNull();
  // The only choice is the timer's length, and counting up comes first.
  expect(
    screen
      .getAllByRole("combobox")
      .map((select) => select.getAttribute("aria-label")),
  ).toEqual(["Timer duration"]);
  const length = screen.getByRole<HTMLSelectElement>("combobox", {
    name: "Timer duration",
  });
  expect([...length.options].map((option) => option.text)).toEqual([
    "Count up",
    "25 min",
    "50 min",
  ]);
  expect(length.value).toBe("0");
  fireEvent.click(
    screen.getByRole("button", { name: "Start: Synthetic leaf" }),
  );
  expect(
    screen.getByRole("button", { name: "Start: Synthetic leaf" }).textContent,
  ).toBe("Start");
  // Counting up unless a pomodoro is chosen, with the area the step takes from its outcome.
  expect(onTimer).toHaveBeenLastCalledWith("start", "copy", undefined, "work");
  fireEvent.change(length, { target: { value: String(25 * 60) } });
  fireEvent.click(
    screen.getByRole("button", { name: "Start: Synthetic leaf" }),
  );
  expect(onTimer).toHaveBeenLastCalledWith("start", "copy", 25 * 60, "work");
  expect(complete).not.toHaveBeenCalled();
});

it("shows confirmed elapsed time and distinct pause, resume and stop controls", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-13T12:00:05Z"));
  const { plan, focus } = await createPrototype().load();
  focus.timer = {
    taskId: "copy",
    day: focus.date,
    area: "work",
    status: "running",
    elapsedSeconds: 80,
    startedAt: new Date(Date.now() - 5000).toISOString(),
    etag: "synthetic-timer-2",
  };
  const onTimer = vi.fn();
  const complete = vi.fn();
  const props = {
    plan,
    focus,
    language: "en" as const,
    busy: false,
    editTask: vi.fn(),
    complete,
    onOpenPlan: vi.fn(),
    onTimer,
  };
  const { rerender } = render(<FocusView {...props} />);
  expect(screen.getByLabelText("Time focused").textContent).toBe("01:25");
  const pause = screen.getByRole("button", {
    name: "Pause: Write the introduction",
  });
  expect(pause.textContent).toBe("Pause");
  fireEvent.click(pause);
  expect(onTimer).toHaveBeenLastCalledWith("pause", "copy");
  rerender(
    <FocusView
      {...props}
      focus={{
        ...focus,
        timer: { ...focus.timer, status: "paused", elapsedSeconds: 85 },
      }}
    />,
  );
  expect(screen.getByLabelText("Time focused").textContent).toBe("01:25");
  const resume = screen.getByRole("button", {
    name: "Resume: Write the introduction",
  });
  expect(resume.textContent).toBe("Resume");
  fireEvent.click(resume);
  expect(onTimer).toHaveBeenLastCalledWith("resume", "copy");
  const stop = screen.getByRole("button", {
    name: "Stop session: Write the introduction",
  });
  expect(stop.textContent).toBe("Stop");
  fireEvent.click(stop);
  expect(onTimer).toHaveBeenLastCalledWith("stop", "copy");
  expect(complete).not.toHaveBeenCalled();
  rerender(<FocusView {...props} focus={{ ...focus, timer: undefined }} />);
  expect(screen.queryByLabelText("Time focused")).toBeNull();
  expect(screen.getByText("Write the introduction")).toBeTruthy();
});

it("sends an empty today queue back to Plan instead of presenting another task picker", async () => {
  const { plan, focus } = await createPrototype().load();
  focus.taskIds = [];
  const onOpenPlan = vi.fn();
  render(
    <FocusView
      plan={plan}
      focus={focus}
      language="en"
      busy={false}
      editTask={vi.fn()}
      complete={vi.fn()}
      onOpenPlan={onOpenPlan}
      onTimer={vi.fn()}
    />,
  );
  expect(screen.getByText("No steps planned for today.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Adjust plan" }));
  expect(onOpenPlan).toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Choose tasks" })).toBeNull();
});

it("starts a step whose outcome has no area as unassigned, which Tasks keeps as no area", async () => {
  const { plan, focus } = await createPrototype().load();
  for (const task of plan.tasks)
    if (task.id === "copy" || task.id === "release") task.area = "unassigned";
  const onTimer = vi.fn();
  render(
    <FocusView
      plan={plan}
      focus={focus}
      language="en"
      busy={false}
      editTask={vi.fn()}
      complete={vi.fn()}
      onOpenPlan={vi.fn()}
      onTimer={onTimer}
    />,
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Start: Write the introduction" }),
  );
  expect(onTimer).toHaveBeenCalledWith(
    "start",
    "copy",
    undefined,
    "unassigned",
  );
});
