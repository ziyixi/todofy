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
import { readableDate } from "../src/PlanningCalendar";

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
      name: "Log time (Outline three questions for the check-in)",
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

/** FocusView's props around today (2026-10-13), with "layout" logged 20 minutes on Monday. */
async function views() {
  const actions = createPrototype();
  await actions.addEntry({
    taskId: "layout",
    date: "2026-10-12",
    seconds: 20 * 60,
    area: "work",
  });
  const { plan, focus } = await actions.load();
  const onNavigate = vi.fn();
  return {
    onNavigate,
    props: {
      plan,
      focus,
      language: "en" as const,
      busy: false,
      editTask: vi.fn(),
      complete: vi.fn(),
      onOpenPlan: vi.fn(),
      onTimer: vi.fn(),
      actions,
      run: vi.fn(),
      onOpenTask: vi.fn(),
      onNavigate,
    },
  };
}

it("shows another day read-only, where a past day's records still change and a future day has nothing to log", async () => {
  const { props, onNavigate } = await views();
  const { rerender } = render(<FocusView {...props} date="2026-10-12" />);
  const past = await screen.findByRole("list", {
    name: `Steps: ${readableDate("2026-10-12", "en")}`,
  });
  expect(within(past).getByText("Check the layout on a phone")).toBeTruthy();
  // No Start, no completion, no timer and no drag grip; the plan is still one click away.
  expect(
    screen.queryByRole("button", {
      name: /^(Start|Complete task|Move step):/u,
    }),
  ).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.getByRole("button", { name: "Adjust plan" })).toBeTruthy();
  expect(
    screen.getByRole("button", {
      name: "20m logged (Check the layout on a phone)",
    }),
  ).toBeTruthy();
  rerender(<FocusView {...props} date="2026-10-14" />);
  const future = await screen.findByRole("list", {
    name: `Steps: ${readableDate("2026-10-14", "en")}`,
  });
  expect(
    within(future).getByText("Clear out the old development branch"),
  ).toBeTruthy();
  expect(future.querySelector(".plus-focus-block-footer")!.textContent).toBe(
    "Not estimated",
  );
  // The dates move by a day, and Today comes back.
  fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
  expect(onNavigate).toHaveBeenLastCalledWith("2026-10-13");
  fireEvent.click(screen.getByRole("button", { name: "Next day" }));
  expect(onNavigate).toHaveBeenLastCalledWith("2026-10-15");
  fireEvent.click(screen.getByRole("button", { name: "Today" }));
  expect(onNavigate).toHaveBeenLastCalledWith("2026-10-13");
  expect(screen.queryByRole("tab")).toBeNull();
  rerender(<FocusView {...props} date="2026-10-15" />);
  expect(
    await screen.findByText("No steps planned for this day."),
  ).toBeTruthy();
});

it("keeps a day's records of steps that left its queue under Other time, where they still change", async () => {
  const { props } = await views();
  // Monday's step moved on after its 20 minutes; today has 15 minutes on Wednesday's step.
  await props.actions.removeFromDay("layout", "2026-10-12");
  await props.actions.addEntry({
    taskId: "cleanup",
    date: "2026-10-13",
    seconds: 15 * 60,
    area: "work",
  });
  const { focus } = await props.actions.load();
  const { rerender } = render(
    <FocusView {...props} focus={focus} date="2026-10-12" />,
  );
  expect(
    await screen.findByText("No steps planned for this day."),
  ).toBeTruthy();
  let other = screen.getByRole("region", { name: "Other time" });
  expect(
    within(other).getByRole("button", {
      name: "20m logged (Check the layout on a phone)",
    }),
  ).toBeTruthy();
  // Today: the card follows the open queue, read-only, and the summary adds up with it.
  rerender(<FocusView {...props} focus={focus} />);
  const queue = await screen.findByRole("list", { name: "Today's steps" });
  expect(queue.querySelector('[data-task-id="cleanup"]')).toBeNull();
  other = screen.getByRole("region", { name: "Other time" });
  expect(
    queue.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    within(other).getByRole("button", {
      name: "15m logged (Clear out the old development branch)",
    }),
  ).toBeTruthy();
  expect(
    within(other).queryByRole("button", {
      name: /^(Start|Complete task|Move step):/u,
    }),
  ).toBeNull();
  expect(
    document.querySelector(".plus-focus-totals")!.textContent,
  ).toContain("15m logged");
});

it("keeps Focus daily, opens statistics separately, rereads a past day after writes, and offers a retry", async () => {
  const actions = createPrototype();
  const readFocus = vi.spyOn(actions, "readFocus");
  const onOpenGtd = vi.fn();
  render(
    <App
      actions={actions}
      language="en"
      onOpenTask={vi.fn()}
      onSettings={vi.fn()}
      onOpenGtd={onOpenGtd}
      view="focus"
    />,
  );
  const start = await screen.findByRole("button", {
    name: "Start: Write the introduction",
  });
  await act(async () => {
    fireEvent.click(start);
  });
  const subtitle = () => document.querySelector(".plus-subtitle")!.textContent;
  expect(subtitle()).toBe(
    `${readableDate("2026-10-13", "en")} · America/Los_Angeles`,
  );
  expect(
    (screen.getByRole("button", { name: "Today" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  readFocus.mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
  expect(subtitle()).toBe(
    `${readableDate("2026-10-12", "en")} · America/Los_Angeles`,
  );
  const failed = await screen.findByText("Couldn't load these days.");
  // Today's list stays, dimmed and out of reach, until the day arrives.
  expect(
    document
      .querySelector(".plus-focus-range.is-loading")!
      .hasAttribute("inert"),
  ).toBe(true);
  fireEvent.click(
    within(failed.parentElement!).getByRole("button", { name: "Refresh" }),
  );
  expect(
    await screen.findByRole("list", {
      name: `Steps: ${readableDate("2026-10-12", "en")}`,
    }),
  ).toBeTruthy();
  expect(
    (screen.getByRole("button", { name: "Today" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(screen.getByRole("checkbox", { name: "Completed" })).toBeTruthy();
  expect(screen.queryByRole("tab")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View statistics" }));
  expect(onOpenGtd).toHaveBeenCalledExactlyOnceWith("time");
  const dayReads = () =>
    readFocus.mock.calls.filter(([day]) => day === "2026-10-12").length;
  expect(dayReads()).toBe(2);
  // Stopping today's timer from its bar also refreshes the historical day on screen.
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
  });
  await vi.waitFor(() => expect(dayReads()).toBe(3));
});

it("opens the day selected from statistics and keeps daily navigation local", async () => {
  const actions = createPrototype();
  const readFocus = vi.spyOn(actions, "readFocus");
  const props = {
    actions,
    language: "en" as const,
    onOpenTask: vi.fn(),
    onSettings: vi.fn(),
    view: "focus" as const,
    focusDay: "2026-10-12",
  };
  const { rerender } = render(<App {...props} />);
  await screen.findByRole("list", {
    name: `Steps: ${readableDate("2026-10-12", "en")}`,
  });
  expect(readFocus).toHaveBeenLastCalledWith("2026-10-12");
  fireEvent.click(screen.getByRole("button", { name: "Next day" }));
  await screen.findByRole("list", { name: "Today's steps" });
  expect(document.querySelector(".plus-subtitle")!.textContent).toContain(
    readableDate("2026-10-13", "en"),
  );
  // A fresh GTD selection works while the page remains mounted for its mini timer.
  rerender(<App {...props} focusDay="2026-10-14" />);
  await screen.findByRole("list", {
    name: `Steps: ${readableDate("2026-10-14", "en")}`,
  });
  expect(readFocus).toHaveBeenLastCalledWith("2026-10-14");
  rerender(<App {...props} background focusDay="2026-10-14" />);
  rerender(<App {...props} focusDay="2026-10-14" />);
  await screen.findByRole("list", {
    name: `Steps: ${readableDate("2026-10-14", "en")}`,
  });
});
