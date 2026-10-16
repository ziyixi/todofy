import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { FocusView } from "../src/FocusView";
import { PlanView, type PlanViewProps } from "../src/PlanView";
import { TaskEditor } from "../src/TaskEditor";
import { addDays } from "../src/domain";
import { createPrototype } from "../design/fixture";
import type { PlanningTask, PlusActions, PlusData, View } from "../src/model";

// The fixture's today is Tuesday 2026-10-13.
const TODAY = "2026-10-13";
const on = (days: number) => addDays(TODAY, days);
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse(`${TODAY}T12:00:00Z`), toFake: ["Date"] });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Synthetic tasks for each Deadlines status, as Todofy would mark them. */
function deadlineTasks(template: PlanningTask): PlanningTask[] {
  const task = (id: string, title: string, value: Partial<PlanningTask>) => ({
    ...template,
    id,
    title,
    parentId: "",
    stage: "none" as const,
    bet: false,
    labels: [],
    mustStart: false,
    missingLead: false,
    leadDays: 0,
    ...value,
  });
  return [
    task("draft", "Quarterly report draft", {
      deadline: on(-2),
      leadDays: 7,
      mustStart: true,
    }),
    task("claim", "Submit the expense claim", {
      deadline: on(1),
      leadDays: 3,
      mustStart: true,
    }),
    task("visa", "Prepare the visa documents", {
      deadline: on(5),
      leadDays: 7,
      mustStart: true,
    }),
    task("move", "Move house", {
      deadline: on(12),
      leadDays: 14,
      labels: ["active"],
    }),
    task("insurance", "Renew the car insurance", {
      deadline: "2026-11-30",
      missingLead: true,
    }),
  ];
}
async function setup(
  change?: (data: PlusData) => void,
  actions: PlusActions = createPrototype(),
) {
  const data = await actions.load();
  data.plan.tasks.push(...deadlineTasks(data.plan.tasks[0]!));
  change?.(data);
  const props: PlanViewProps = {
    plan: data.plan,
    days: data.days,
    flowTasks: data.focus.flowTasks,
    currentDate: data.focus.date,
    language: "en",
    busy: false,
    actions,
    run: vi.fn(async (operation: () => Promise<unknown>) => {
      await operation();
      return true;
    }),
    editTask: vi.fn(),
    onWeekChange: vi.fn(),
    todayTaskIds: data.focus.taskIds,
    addFocus: vi.fn(),
    addStep: vi.fn(),
    chooseLead: vi.fn(),
    onOpenTask: vi.fn(),
    completeReview: vi.fn(async () => true),
  };
  return { data, props };
}
const rowText = (list: HTMLElement) =>
  within(list)
    .getAllByRole("listitem")
    .map((item) =>
      [
        item.querySelector(".planning-row-title")!.textContent,
        // The visible status, without its screen-reader date.
        [...item.querySelector(".planning-row-status")!.childNodes]
          .filter(
            (node) =>
              !(node instanceof Element && node.matches(".plus-sr-only")),
          )
          .map((node) => node.textContent)
          .join(""),
        item.querySelector(".planning-row-actions")!.textContent,
      ].join(" | "),
    );
/** Deadlines' own status region, beside the list; dnd-kit adds another for drags. */
const announced = () =>
  document.querySelector('.planning-deadlines + [role="status"]')!.textContent;

it("replaces Needs a look with Deadlines between Review and Waiting, open when something is due", async () => {
  const { props } = await setup();
  render(<PlanView {...props} />);
  const deadlines = screen.getByText(/^Deadlines · 6$/u).closest("details")!;
  expect(deadlines.open).toBe(true);
  expect(screen.queryByText(/Needs a look/u)).toBeNull();
  // Daily first: the four lanes, then Deadlines, then Waiting.
  const order = [
    ".review-board",
    ".planning-deadlines",
    ".planning-waiting",
  ].map((selector) => document.querySelector(selector)!);
  expect(
    order[0]!.compareDocumentPosition(order[1]!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(
    order[1]!.compareDocumentPosition(order[2]!) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(rowText(screen.getByRole("list", { name: "Deadlines" }))).toEqual([
    "Quarterly report draft | 2 days past | Mark in progress",
    "Submit the expense claim | Deadline tomorrow | Mark in progress",
    // The fixture's own commitment, in its start window.
    "Prepare the next research check-in | 2 days left | Mark in progress",
    "Prepare the visa documents | 5 days left | Mark in progress",
    "Move house | In progress · 12 days left | ",
    "Renew the car insurance | Deadline Nov 30 | Choose when to start",
  ]);
  // Only the days past use the danger colour. The full date is the status's tooltip; screen
  // readers hear what the status does not already say.
  const list = screen.getByRole("list", { name: "Deadlines" });
  const first = list.firstElementChild!;
  expect(first.querySelector(".planning-danger-text")!.textContent).toBe(
    "2 days past",
  );
  expect(document.querySelectorAll(".planning-danger-text")).toHaveLength(1);
  expect(
    first.querySelector(".planning-row-status")!.getAttribute("title"),
  ).toBe("Deadline: Sun, Oct 11");
  expect(
    [...list.querySelectorAll(".planning-row-status")].map(
      (status) => status.textContent,
    ),
  ).toEqual([
    "2 days past, Sun, Oct 11",
    "Deadline tomorrow, Wed, Oct 14",
    "2 days left, Thu, Oct 15",
    "5 days left, Sun, Oct 18",
    "In progress · 12 days left, Sun, Oct 25",
    "Deadline Nov 30, Mon",
  ]);
  // Actions are in the accessibility tree, named with their task.
  expect(
    screen.getByRole("button", {
      name: "Mark in progress: Quarterly report draft",
    }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Choose when to start: Renew the car insurance",
    }),
  );
  expect(props.chooseLead).toHaveBeenCalledWith(
    expect.objectContaining({ id: "insurance" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Move house" }));
  expect(props.editTask).toHaveBeenCalledWith(
    expect.objectContaining({ id: "move" }),
  );
});

it("stays closed with nothing due, follows the owner's toggle, and shows below the Week calendar", async () => {
  const { props } = await setup((data) => {
    data.plan.tasks = data.plan.tasks.filter(
      (task) => !task.mustStart || task.id === "research",
    );
    data.plan.tasks.find((task) => task.id === "research")!.mustStart = false;
  });
  function Visit() {
    const [open, setOpen] = useState<boolean>();
    return (
      <PlanView {...props} deadlinesOpen={open} onDeadlinesToggle={setOpen} />
    );
  }
  render(<Visit />);
  const summary = screen.getByText(/^Deadlines · 2$/u);
  expect(summary.closest("details")!.open).toBe(false);
  fireEvent.click(summary);
  await waitFor(() => expect(summary.closest("details")!.open).toBe(true));
  // The choice holds across Review and Week, where Deadlines follows the calendar.
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  const week = document.querySelector(".planning-week")!;
  const list = document.querySelector<HTMLDetailsElement>(
    ".planning-deadlines",
  )!;
  expect(list.open).toBe(true);
  expect(
    week.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  expect(document.querySelector(".planning-waiting")).toBeNull();
});

it("marks a task in progress with one confirmed write, says so, and moves focus on", async () => {
  const actions = createPrototype();
  // Todofy's confirmed task: the literal label added, no longer must start.
  const update = vi
    .spyOn(actions, "updateTask")
    .mockImplementation(async (task) => ({
      ...task,
      labels: [...task.labels, "active"],
      mustStart: false,
    }));
  const { props } = await setup(undefined, actions);
  const { rerender } = render(<PlanView {...props} />);
  const mark = screen.getByRole("button", {
    name: "Mark in progress: Submit the expense claim",
  });
  mark.focus();
  fireEvent.click(mark);
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update.mock.calls[0]![1]).toEqual({ active: true });
  const saved = await update.mock.results[0]!.value;
  // The App merges the confirmed task; the row becomes in progress where it was.
  rerender(
    <PlanView
      {...props}
      plan={{
        ...props.plan,
        tasks: props.plan.tasks.map((task) =>
          task.id === saved.id ? saved : task,
        ),
      }}
    />,
  );
  await waitFor(() =>
    expect(announced()).toBe("Marked in progress: Submit the expense claim"),
  );
  expect(rowText(screen.getByRole("list", { name: "Deadlines" }))[1]).toBe(
    "Submit the expense claim | In progress · Deadline tomorrow | ",
  );
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "Mark in progress: Prepare the next research check-in",
  );
});

it("keeps Deadlines open once a row is acted on, also when its last due row is marked", async () => {
  const actions = createPrototype();
  vi.spyOn(actions, "updateTask").mockImplementation(async (task) => ({
    ...task,
    labels: [...task.labels, "active"],
    mustStart: false,
  }));
  // One due row, beside an in-progress and a no-lead row.
  const { props } = await setup((data) => {
    data.plan.tasks = data.plan.tasks.filter(
      (task) => !task.mustStart || task.id === "claim",
    );
  }, actions);
  let merge: (saved: PlanningTask) => void = () => {};
  function Visit() {
    const [open, setOpen] = useState<boolean>();
    const [tasks, setTasks] = useState(props.plan.tasks);
    // As the App does: merge each confirmed task, without reading the list again.
    merge = (saved) =>
      setTasks((current) =>
        current.map((task) => (task.id === saved.id ? saved : task)),
      );
    return (
      <PlanView
        {...props}
        plan={{ ...props.plan, tasks }}
        run={async (operation) => {
          merge((await operation()) as PlanningTask);
          return true;
        }}
        deadlinesOpen={open}
        onDeadlinesToggle={setOpen}
      />
    );
  }
  const details = () =>
    document.querySelector<HTMLDetailsElement>(".planning-deadlines")!;
  const { unmount } = render(<Visit />);
  expect(details().open).toBe(true);
  const mark = screen.getByRole("button", {
    name: "Mark in progress: Submit the expense claim",
  });
  mark.focus();
  fireEvent.click(mark);
  // Nothing is due any more, yet the row changes in place and focus moves to the next action.
  await waitFor(() =>
    expect(announced()).toBe("Marked in progress: Submit the expense claim"),
  );
  expect(details().open).toBe(true);
  expect(rowText(screen.getByRole("list", { name: "Deadlines" }))).toEqual([
    "Submit the expense claim | In progress · Deadline tomorrow | ",
    "Move house | In progress · 12 days left | ",
    "Renew the car insurance | Deadline Nov 30 | Choose when to start",
  ]);
  expect(document.activeElement?.getAttribute("aria-label")).toBe(
    "Choose when to start: Renew the car insurance",
  );
  unmount();

  // The editor's own mark, opened from the row's title: the list stays open for the way back.
  render(<Visit />);
  fireEvent.click(
    screen.getByRole("button", { name: "Submit the expense claim" }),
  );
  expect(props.editTask).toHaveBeenCalledWith(
    expect.objectContaining({ id: "claim" }),
  );
  const claim = props.plan.tasks.find((task) => task.id === "claim")!;
  const saved = await actions.updateTask(claim, { active: true });
  act(() => merge(saved));
  expect(details().open).toBe(true);
});

it("offers no in-progress write while the account has no active label", async () => {
  const { props } = await setup((data) => {
    data.plan.availableLabels = data.plan.availableLabels.filter(
      (label) => label.label !== "active",
    );
  });
  render(<PlanView {...props} />);
  expect(
    screen.queryByRole("button", { name: /^Mark in progress/u }),
  ).toBeNull();
  expect(
    screen.getByRole("button", {
      name: "Choose when to start: Renew the car insurance",
    }),
  ).toBeTruthy();
});

it("adds the deadline to Waiting rows, whose actions show on hover or focus", async () => {
  const { props } = await setup((data) => {
    data.plan.tasks.find((task) => task.id === "venue")!.deadline = on(9);
    data.plan.tasks.find((task) => task.id === "access")!.deadline = on(-2);
  });
  render(<PlanView {...props} />);
  fireEvent.click(screen.getByText("Waiting · 2"));
  const list = screen.getByRole("list", { name: "Waiting" });
  expect(rowText(list)).toEqual([
    "Hear back about the venue quote | Untouched 11 days · Deadline Oct 22 | Add follow-up stepAdd to todayOpen",
    "Lab access approval | Untouched 3 days · 2 days past deadline | Add follow-up stepAdd to todayOpen",
  ]);
  expect(list.querySelector(".planning-danger-text")!.textContent).toBe(
    "2 days past deadline",
  );
  // The actions keep their column and stay reachable: hidden only by opacity in CSS.
  expect(list.querySelectorAll(".planning-row-actions button")).toHaveLength(6);
});

it("shows Focus's quiet line only for due tasks with nothing planned, and opens Plan's Deadlines", async () => {
  const actions = createPrototype();
  const { data } = await setup(undefined, actions);
  const onShowDeadlines = vi.fn();
  const props = {
    plan: data.plan,
    focus: data.focus,
    days: data.days,
    language: "en" as const,
    busy: false,
    editTask: vi.fn(),
    complete: vi.fn(),
    onOpenPlan: vi.fn(),
    onTimer: vi.fn(),
    onShowDeadlines,
  };
  const { rerender } = render(<FocusView {...props} />);
  // Research's step is in today's queue, so only the draft, the claim and the visa count.
  const line = screen.getByRole("button", {
    name: "1 past deadline and 2 in their start window, not planned this week",
  });
  expect(line.getAttribute("title")).toBe("Show in Plan");
  fireEvent.click(line);
  expect(onShowDeadlines).toHaveBeenCalledOnce();
  rerender(<FocusView {...props} language="zh" />);
  expect(
    screen.getByText("1 项已过截止、2 项已到启动窗口，这周还没有安排"),
  ).toBeTruthy();
  // Planned this week: the line goes.
  rerender(
    <FocusView
      {...props}
      days={data.days.map((day) =>
        day.date === on(2)
          ? { ...day, taskIds: [...day.taskIds, "draft", "claim", "visa"] }
          : day,
      )}
    />,
  );
  expect(document.querySelector(".plus-focus-runway")).toBeNull();
});

it("takes Focus's line to Review with Deadlines open and its summary focused", async () => {
  const actions = createPrototype();
  const load = actions.load.bind(actions);
  vi.spyOn(actions, "load").mockImplementation(async (week) => {
    const data = await load(week);
    data.plan.tasks.push(...deadlineTasks(data.plan.tasks[0]!));
    return data;
  });
  function Visit() {
    const [view, setView] = useState<View>("focus");
    return (
      <App
        actions={actions}
        view={view}
        language="en"
        onOpenTask={() => {}}
        onSettings={() => {}}
        onViewChange={setView}
      />
    );
  }
  render(<Visit />);
  fireEvent.click(
    await screen.findByRole("button", { name: /not planned this week$/u }),
  );
  const summary = await screen.findByText(/^Deadlines · 6$/u);
  expect(summary.closest("details")!.open).toBe(true);
  await waitFor(() => expect(document.activeElement).toBe(summary));
  expect(
    screen.getByRole("tab", { name: "Review" }).getAttribute("aria-selected"),
  ).toBe("true");
});

it("opens the editor at the start-ahead choice from Choose when to start", async () => {
  const actions = createPrototype();
  const load = actions.load.bind(actions);
  vi.spyOn(actions, "load").mockImplementation(async (week) => {
    const data = await load(week);
    data.plan.tasks.push(...deadlineTasks(data.plan.tasks[0]!));
    return data;
  });
  render(
    <App
      actions={actions}
      view="plan"
      language="en"
      onOpenTask={() => {}}
      onSettings={() => {}}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Choose when to start: Renew the car insurance",
    }),
  );
  const editor = within(screen.getByRole("region", { name: "Steps & timing" }));
  await waitFor(() =>
    expect(document.activeElement).toBe(editor.getByLabelText("Start ahead")),
  );
});

it("says where a deadline stands in task details and marks it in progress there", async () => {
  const actions = createPrototype();
  const update = vi
    .spyOn(actions, "updateTask")
    .mockImplementation(async (task) => task);
  const { data } = await setup(undefined, actions);
  const visa = data.plan.tasks.find((task) => task.id === "visa")!;
  const run = vi.fn(async (operation: () => Promise<unknown>) => {
    await operation();
    return true;
  });
  const editor = (task: PlanningTask, canMarkActive = true) => (
    <TaskEditor
      key={task.labels.join()}
      task={task}
      tasks={data.plan.tasks}
      language="en"
      busy={false}
      run={run}
      actions={actions}
      todayTaskIds={[]}
      today={TODAY}
      canMarkActive={canMarkActive}
      addFocus={vi.fn()}
      onOpenTask={vi.fn()}
    />
  );
  const { rerender } = render(editor(visa));
  expect(screen.getByText("Start window open · 5 days left")).toBeTruthy();
  // "1 day", not "1 days".
  expect(
    [...screen.getByLabelText("Start ahead").querySelectorAll("option")].map(
      (option) => option.textContent,
    ),
  ).toEqual(["Not set", "1 day", "3 days", "7 days", "14 days", "30 days"]);
  // A date being chosen already says where it stands.
  fireEvent.change(screen.getByLabelText("Deadline"), {
    target: { value: on(20) },
  });
  expect(screen.getByText("Start window: Tue, Oct 27")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Mark in progress" }));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update.mock.calls[0]![1]).toEqual({ active: true });
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "Steps & timing" })).getByRole(
        "status",
      ).textContent,
    ).toBe("Marked in progress: Prepare the visa documents"),
  );
  rerender(editor({ ...visa, labels: ["active"] }));
  expect(screen.getByText("In progress · 5 days left")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Not in progress" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update.mock.calls[1]![1]).toEqual({ active: false });
  // No button without the account's label or without a deadline.
  rerender(editor(visa, false));
  expect(screen.queryByRole("button", { name: /in progress/iu })).toBeNull();
  rerender(editor({ ...visa, deadline: "", labels: [] }));
  expect(screen.queryByRole("button", { name: /in progress/iu })).toBeNull();
  await act(async () => {});
});

it("names a due card's start window, which its icon's tooltip repeats", async () => {
  const { props } = await setup((data) => {
    const visa = data.plan.tasks.find((task) => task.id === "visa")!;
    visa.stage = "committed";
  });
  render(<PlanView {...props} />);
  const card = screen.getByRole("button", {
    name: "Prepare the visa documents, No priority, Start window open · 5 days left",
  });
  expect(
    card.querySelector(".planning-outcome-start")!.getAttribute("title"),
  ).toBe("Start window open · 5 days left");
});
