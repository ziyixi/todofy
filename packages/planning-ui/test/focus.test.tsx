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
import { readableDate, weekLabel } from "../src/PlanningCalendar";

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
      name: "20m logged: Check the layout on a phone",
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
  expect(onNavigate).toHaveBeenLastCalledWith("day", "2026-10-13");
  fireEvent.click(screen.getByRole("button", { name: "Next day" }));
  expect(onNavigate).toHaveBeenLastCalledWith("day", "2026-10-15");
  fireEvent.click(screen.getByRole("button", { name: "Today" }));
  expect(onNavigate).toHaveBeenLastCalledWith("day", "2026-10-13");
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  expect(onNavigate).toHaveBeenLastCalledWith("week", "2026-10-14");
  rerender(<FocusView {...props} date="2026-10-15" />);
  expect(
    await screen.findByText("No steps planned for this day."),
  ).toBeTruthy();
});

it("draws Week as a bar a day, each named in full, which opens that day", async () => {
  const { props, onNavigate } = await views();
  render(<FocusView {...props} tab="week" date="2026-10-14" />);
  const monday = await screen.findByRole("button", {
    name: `${readableDate("2026-10-12", "en")}: 20m logged, work 20m, 0 of 1 steps done`,
  });
  expect(
    screen.getByRole("button", {
      name: `${readableDate("2026-10-13", "en")}: 0m logged, 0 of 3 steps done`,
    }).className,
  ).toBe("is-today");
  expect(document.querySelectorAll(".plus-focus-bars > button")).toHaveLength(
    7,
  );
  expect(
    [...document.querySelectorAll(".plus-focus-stats dd")].map(
      (value) => value.textContent,
    ),
  ).toEqual(["20m", "20m", "0m", "0"]);
  // Where the time went: the step's parent, in Work's colour.
  const group = screen
    .getByRole("heading", { name: "Where the time went" })
    .nextElementSibling!.querySelector("li")!;
  expect(group.querySelector(".planning-full-title-text")!.textContent).toBe(
    "Ship the small website refresh",
  );
  expect(group.querySelector(".plus-focus-group-time")!.textContent).toBe(
    "20m",
  );
  expect(group.getAttribute("style")).toContain("var(--plus-area-work)");
  fireEvent.click(monday);
  expect(onNavigate).toHaveBeenLastCalledWith("day", "2026-10-12");
  // The arrows move by a week.
  fireEvent.click(screen.getByRole("button", { name: "Next week" }));
  expect(onNavigate).toHaveBeenLastCalledWith("week", "2026-10-21");
});

it("draws Month as a shaded calendar of its own days, each opening in Day", async () => {
  const { props, onNavigate } = await views();
  render(<FocusView {...props} tab="month" date="2026-10-14" />);
  const monday = await screen.findByRole("button", {
    name: `${readableDate("2026-10-12", "en")}: 20m logged, work 20m, 0 of 1 steps done`,
  });
  expect(monday.getAttribute("data-level")).toBe("1");
  expect(monday.textContent).toBe("1220m");
  // October 2026 starts on a Thursday and ends on a Saturday: five weeks, the neighbours faded
  // and not buttons.
  expect(document.querySelectorAll(".plus-focus-month-day")).toHaveLength(35);
  const outside = [
    ...document.querySelectorAll(".plus-focus-month-day.is-outside"),
  ];
  expect(outside.map((cell) => cell.textContent)).toEqual([
    "28",
    "29",
    "30",
    "1",
  ]);
  expect(outside.every((cell) => cell.tagName === "SPAN")).toBe(true);
  fireEvent.click(monday);
  expect(onNavigate).toHaveBeenLastCalledWith("day", "2026-10-12");
  fireEvent.click(screen.getByRole("button", { name: "Previous month" }));
  expect(onNavigate).toHaveBeenLastCalledWith("month", "2026-09-01");
});

it("keeps Focus's view and date in the page header, reads them once, again after a write, and offers a retry", async () => {
  const actions = createPrototype();
  const readFocus = vi.spyOn(actions, "readFocus");
  render(
    <App
      actions={actions}
      language="en"
      onOpenTask={vi.fn()}
      onSettings={vi.fn()}
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
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  expect(subtitle()).toBe(
    `${weekLabel("2026-10-12", "en")} · America/Los_Angeles`,
  );
  // The Completed checkbox belongs to Day.
  expect(screen.queryByRole("checkbox", { name: "Completed" })).toBeNull();
  await screen.findAllByRole("button", { name: /: \d+m logged/u });
  const weekReads = () =>
    readFocus.mock.calls.filter(
      ([start, end]) => start === "2026-10-12" && end === "2026-10-18",
    ).length;
  expect(weekReads()).toBe(1);
  // Stopping the session from the timer bar is a write: the week is read again.
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Stop session" }));
  });
  await vi.waitFor(() => expect(weekReads()).toBe(2));
  fireEvent.click(screen.getByRole("tab", { name: "Month" }));
  expect(subtitle()).toBe("October 2026 · America/Los_Angeles");
  await screen.findByRole("button", {
    name: `${readableDate("2026-10-31", "en")}: 0m logged`,
  });
  expect(readFocus).toHaveBeenLastCalledWith("2026-10-01", "2026-10-31");
});
