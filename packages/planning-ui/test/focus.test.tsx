import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createPrototype } from "./fixture";
import { App } from "../src/App";
import { FocusView } from "../src/FocusView";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
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
      actions={createPrototype()}
      run={vi.fn()}
      onOpenTask={vi.fn()}
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
  ).toBe("Est. 15m");
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

it("shows one logged time per card, ticking while its session runs, and distinct pause, resume and stop controls", async () => {
  const { plan, focus } = await createPrototype().load();
  vi.useFakeTimers({ now: Date.parse("2026-10-13T12:00:05Z") });
  focus.timer = {
    taskId: "copy",
    day: focus.date,
    area: "work",
    status: "running",
    elapsedSeconds: 80,
    startedAt: new Date(Date.now() - 5000).toISOString(),
    etag: "synthetic-timer-2",
  };
  // A record saved earlier today counts too.
  focus.entries = [
    {
      id: "earlier",
      taskId: "copy",
      date: focus.date,
      seconds: 10 * 60,
      source: "timer",
      startedAt: "2026-10-13T16:00:00Z",
      area: "work",
      etag: "1",
    },
  ];
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
    actions: createPrototype(),
    run: vi.fn(),
    onOpenTask: vi.fn(),
  };
  const { rerender } = render(<FocusView {...props} />);
  const card = document.querySelector('[data-task-id="copy"]')!;
  const logged = () =>
    card.querySelector(".plus-focus-logged")!.firstChild!.textContent;
  // The card's one time number: saved and running time, as a clock while the session lasts.
  expect(card.querySelectorAll("output")).toHaveLength(0);
  expect(logged()).toBe("11:25 logged");
  expect(card.querySelector(".plus-focus-block-footer")!.textContent).toMatch(
    /^Est\. 30m·11:25 logged/u,
  );
  act(() => {
    vi.advanceTimersByTime(3000);
  });
  expect(logged()).toBe("11:28 logged");
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
  expect(logged()).toBe("11:25 logged");
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
  expect(logged()).toBe("10m logged");
  expect(screen.getByText("Write the introduction")).toBeTruthy();
  // A card with nothing logged offers to log time.
  expect(
    screen.getByRole("button", {
      name: "Log time: Outline three questions for the check-in",
    }),
  ).toBeTruthy();
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
      actions={createPrototype()}
      run={vi.fn()}
      onOpenTask={vi.fn()}
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
      actions={createPrototype()}
      run={vi.fn()}
      onOpenTask={vi.fn()}
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

it("shows the day's completed steps after the open ones only while Completed is checked, off on every visit", async () => {
  const actions = createPrototype();
  const { plan } = await actions.load();
  // "copy" was completed from today's queue earlier, with 35 minutes logged.
  await actions.completeTask(
    plan.tasks.find((task) => task.id === "copy")!,
    "synthetic-request",
    "2026-10-13",
  );
  await actions.addEntry({
    taskId: "copy",
    date: "2026-10-13",
    seconds: 35 * 60,
    area: "work",
  });
  const onOpenTask = vi.fn();
  const props = {
    actions,
    language: "en" as const,
    onOpenTask,
    onSettings: vi.fn(),
  };
  const mounted = render(<App {...props} view="focus" />);
  const toggle = await screen.findByRole("checkbox", { name: "Completed" });
  expect((toggle as HTMLInputElement).checked).toBe(false);
  const queue = screen.getByRole("list", { name: "Today's steps" });
  expect(queue.querySelector('[data-task-id="copy"]')).toBeNull();
  expect(document.querySelector('[data-task-id="copy"]')).toBeNull();
  // No "completed today" line replaces it.
  expect(screen.queryByText(/completed today/u)).toBeNull();
  fireEvent.click(toggle);
  const done = document.querySelector<HTMLElement>('[data-task-id="copy"]')!;
  // After the queue, in a list of their own, with the real title and the time logged.
  expect(queue.contains(done)).toBe(false);
  expect(
    queue.compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(done.closest("ul")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Completed" })).toBeTruthy();
  expect(done.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe(
    "Completed",
  );
  expect(done.querySelector(".plus-focus-block-footer")!.textContent).toMatch(
    /^Est\. 30m·35m logged/u,
  );
  // No Start, no complete; its title opens Tasks' own dialog.
  expect(done.querySelectorAll(".plus-focus-timer-action")).toHaveLength(0);
  fireEvent.click(
    within(done).getByRole("button", { name: "Write the introduction" }),
  );
  expect(onOpenTask).toHaveBeenCalledWith("copy");
  // Leaving Focus and coming back, or a new visit, starts unchecked again.
  mounted.rerender(<App {...props} view="plan" />);
  mounted.rerender(<App {...props} view="focus" />);
  expect(
    (screen.getByRole("checkbox", { name: "Completed" }) as HTMLInputElement)
      .checked,
  ).toBe(false);
  fireEvent.click(screen.getByRole("checkbox", { name: "Completed" }));
  mounted.unmount();
  render(<App {...props} view="focus" />);
  expect(
    (
      (await screen.findByRole("checkbox", {
        name: "Completed",
      })) as HTMLInputElement
    ).checked,
  ).toBe(false);
  expect(document.querySelector('[data-task-id="copy"]')).toBeNull();
});
