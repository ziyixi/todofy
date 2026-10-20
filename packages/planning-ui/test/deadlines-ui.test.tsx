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
import { createPrototype } from "./fixture";
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

/** Synthetic deadline tasks, as Todofy would mark them. */
function deadlineTasks(template: PlanningTask): PlanningTask[] {
  const task = (id: string, title: string, value: Partial<PlanningTask>) => ({
    ...template,
    id,
    title,
    parentId: "",
    stage: "none" as const,
    labels: [],
    planningFlags: [],
    mustStart: false,
    missingLead: false,
    leadDays: 0,
    ...value,
    explicitStage: value.stage ?? "none",
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
      stage: "committed",
      deadline: on(5),
      leadDays: 7,
      mustStart: true,
    }),
    task("move", "Move house", {
      deadline: on(12),
      leadDays: 14,
      planningFlags: ["active"],
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
    completeTask: vi.fn(),
    completeReview: vi.fn(async () => true),
  };
  return { data, props };
}
const lane = (name: string) => screen.getByRole("region", { name });
const laneNames = () =>
  [...document.querySelectorAll(".review-lane")].map((item) =>
    item.getAttribute("aria-label"),
  );
/** Each card's accessible name, which carries its status. */
const cards = (name: string) =>
  [...lane(name).querySelectorAll(".planning-outcome-card")].map((card) =>
    card.getAttribute("aria-label"),
  );
/** The board's status region, beside the lanes; dnd-kit adds another for drags. */
const announced = () =>
  document.querySelector('.review-board > .plus-sr-only[role="status"]')!
    .textContent;

it("puts Start now and then Waiting left of the four stage lanes, with nothing stacked under the board", async () => {
  const { props } = await setup();
  const view = render(<PlanView {...props} />);
  expect(laneNames()).toEqual([
    "Start now",
    "Waiting",
    "Parked",
    "Quarter",
    "Month",
    "Week",
    "Committed",
  ]);
  expect(
    document.querySelector(".review-lanes")!.getAttribute("data-lanes"),
  ).toBe("7");
  // Start now: title and one status, earliest deadline first; screen readers also hear the
  // area, which the card's edge shows, and the date the status does not say.
  expect(cards("Start now")).toEqual([
    "Quarterly report draft, Work, No priority, 2 days late, Sun, Oct 11",
    "Submit the expense claim, Work, No priority, Deadline tomorrow, Wed, Oct 14",
  ]);
  const draft = lane("Start now").querySelector(".planning-outcome-card")!;
  expect(draft.querySelector(".planning-outcome-context")).toBeNull();
  expect(
    draft.querySelector(".planning-outcome-title")!.hasAttribute("title"),
  ).toBe(false);
  const status = draft.querySelector(".planning-outcome-status")!;
  expect(status.textContent).toBe("2 days late");
  expect(status.getAttribute("title")).toBe("Deadline: Sun, Oct 11");
  expect(draft.querySelector(".planning-outcome-counts")).toBeNull();
  // The one colour on the board: days past a deadline.
  expect(
    [...document.querySelectorAll(".planning-danger-text")].map(
      (item) => item.textContent,
    ),
  ).toEqual(["2 days late"]);
  // Start now and Waiting have no label of their own and take no drops.
  expect(lane("Start now").querySelector(".review-lane-header small")).toBe(
    null,
  );
  expect(lane("Waiting").querySelector(".review-lane-header small")).toBe(null);
  expect(cards("Waiting")).toEqual([
    "Hear back about the venue quote, Work, No priority, No change in 11 days",
    "Lab access approval, Work, No priority, No change in 3 days",
  ]);
  // In progress and no-lead tasks are not on the board.
  for (const title of ["Move house", "Renew the car insurance"])
    expect(
      screen.queryByRole("button", { name: new RegExp(`^${title}`, "u") }),
    ).toBeNull();
  // Nothing is stacked under the board or the Week calendar: only the reset note follows. Under the
  // lanes, the dependencies' one-time notice is an empty status region until it has a line.
  const sections = () =>
    [...document.querySelector(".planning-view")!.children]
      .filter((child) => !child.hasAttribute("data-dnd-overlay"))
      .map((child) => child.className);
  expect(sections()).toEqual([
    "planning-toolbar",
    "planning-area-filter",
    "review-board",
    "planning-reset-note",
  ]);
  expect(
    document.querySelector(".review-board-notices")!.children,
  ).toHaveLength(0);
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  expect(sections()).toEqual([
    "planning-toolbar",
    "planning-week",
    "planning-reset-note",
  ]);
  expect(document.querySelectorAll("details")).toHaveLength(0);
  view.unmount();
});

it("keeps the step counts on Week's commitment cards, which say nothing of waiting or starting", async () => {
  const { props } = await setup();
  render(<PlanView {...props} />);
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  const overview = document.querySelector(".planning-commitment-grid")!;
  // Research and the visa are in their start windows; on the board they say so.
  for (const id of ["research", "visa"])
    expect(
      overview.querySelector(
        `[data-outcome-id="${id}"] .planning-outcome-counts`,
      )?.textContent,
    ).toMatch(/^\d+ steps? · \d+ planned$/u);
  expect(overview.querySelector(".planning-outcome-status")).toBeNull();
});

it("hides Start now and Waiting while they have no cards", async () => {
  const { props } = await setup((data) => {
    data.plan.tasks = data.plan.tasks.filter(
      (task) => !["draft", "claim", "venue", "access"].includes(task.id),
    );
  });
  render(<PlanView {...props} />);
  expect(laneNames()).toEqual([
    "Parked",
    "Quarter",
    "Month",
    "Week",
    "Committed",
  ]);
  expect(
    document.querySelector(".review-lanes")!.getAttribute("data-lanes"),
  ).toBe("5");
});

it("puts Parked between Waiting and the stages, and shows it empty too", async () => {
  const { props } = await setup();
  render(<PlanView {...props} />);
  expect(laneNames()).toEqual([
    "Start now",
    "Waiting",
    "Parked",
    "Quarter",
    "Month",
    "Week",
    "Committed",
  ]);
  expect(
    document.querySelector(".review-lanes")!.getAttribute("data-lanes"),
  ).toBe("7");
  // A parked card says how long it has been untouched in place of its step counts.
  expect(cards("Parked")).toEqual([
    "Plan a small balcony garden, Personal, No priority, No change in 53 days",
  ]);
  expect(lane("Parked").querySelector(".planning-outcome-counts")).toBeNull();
  // Filtered empty, it stays in place as a drop target.
  fireEvent.click(screen.getByRole("tab", { name: "Work" }));
  expect(laneNames()).toContain("Parked");
  expect(lane("Parked").textContent).toContain("Drop here to park");
});

it("shows Parked's first three cards, then a quiet line for the rest", async () => {
  const { props } = await setup((data) => {
    const template = data.plan.tasks.find((task) => task.id === "garden")!;
    for (let index = 1; index <= 4; index++)
      data.plan.tasks.push({
        ...template,
        id: `idea-${index}`,
        title: `Synthetic idea ${index}`,
        updatedAt: undefined,
      });
  });
  render(<PlanView {...props} language="zh" />);
  const parked = lane("搁置");
  // The most untouched first: the fixture's garden, unchanged for 53 days, then those Todoist
  // gave no time.
  expect(
    [
      ...parked.querySelectorAll(
        ".planning-outcome-title .planning-full-title-text",
      ),
    ].map((title) => title.textContent),
  ).toEqual([
    "Plan a small balcony garden",
    "Synthetic idea 1",
    "Synthetic idea 2",
  ]);
  const more = within(parked).getByRole("button", { name: "再显示 2 项" });
  expect(more.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(more);
  expect(parked.querySelectorAll(".planning-outcome-card")).toHaveLength(5);
  expect(more.textContent).toBe("收起");
  expect(parked.querySelector(".review-lane-header > span")!.textContent).toBe(
    "5",
  );
});

it("keeps a staged task in its lane with one quiet status, and a date-rule candidate that should start in Start now", async () => {
  const { props } = await setup((data) => {
    const template = data.plan.tasks[0]!;
    data.plan.tasks.push({
      ...template,
      id: "dated",
      title: "Book the venue",
      stage: "weekly",
      explicitStage: "none",
      planningFlags: [],
      deadline: on(3),
      leadDays: 7,
      mustStart: true,
    });
    const notes = data.plan.tasks.find((task) => task.id === "notes")!;
    notes.planningFlags = ["waiting"];
    notes.updatedAt = "2026-10-06T09:00:00Z";
  });
  render(<PlanView {...props} />);
  // Only the 7-day date rule made "Book the venue" a Week candidate.
  expect(cards("Start now")).toContain(
    "Book the venue, Work, No priority, 3 days left, Fri, Oct 16",
  );
  expect(cards("Week")).not.toContainEqual(
    expect.stringMatching(/^Book the venue/u),
  );
  expect(cards("Committed")).toEqual([
    "Ship the small website refresh, Work, No priority",
    "Prepare the next research check-in, Work, No priority, 2 days left, Thu, Oct 15",
    "Organize the experiment notes, Work, No priority, No change in 7 days",
    "Prepare the visa documents, Work, No priority, 5 days left, Sun, Oct 18",
    "Make the home desk comfortable, Personal, No priority",
  ]);
  // The status takes the step counts' place; other cards keep their counts.
  const committed = lane("Committed");
  expect(
    [...committed.querySelectorAll(".planning-outcome-meta")].map(
      (meta) => meta.lastElementChild!.textContent,
    ),
  ).toEqual([
    "2 steps · 2 planned",
    "2 days left",
    "No change in 7 days",
    "5 days left",
    "1 step · 0 planned",
  ]);
  expect(cards("Waiting")).not.toContainEqual(
    expect.stringMatching(/^Organize the experiment notes/u),
  );
});

it("marks a card in progress from its Start, in one confirmed write, and moves focus to the next Start", async () => {
  const actions = createPrototype();
  // Todofy's confirmed task: in progress, no longer must start.
  const update = vi
    .spyOn(actions, "updateTask")
    .mockImplementation(async (task) => ({
      ...task,
      planningFlags: [...(task.planningFlags ?? []), "active"],
      mustStart: false,
    }));
  const { props } = await setup(undefined, actions);
  function Visit() {
    const [tasks, setTasks] = useState(props.plan.tasks);
    // As the App does: merge the confirmed task, without reading the list again.
    return (
      <PlanView
        {...props}
        plan={{ ...props.plan, tasks }}
        run={async (operation) => {
          const saved = (await operation()) as PlanningTask;
          setTasks((current) =>
            current.map((task) => (task.id === saved.id ? saved : task)),
          );
          return true;
        }}
      />
    );
  }
  render(<Visit />);
  // Every card that should start has one, staged ones too, named with its task.
  expect(
    [...document.querySelectorAll(".review-card-action")].map((action) =>
      action.getAttribute("aria-label"),
    ),
  ).toEqual([
    "Start: Quarterly report draft",
    "Start: Submit the expense claim",
    "Start: Prepare the next research check-in",
    "Start: Prepare the visa documents",
  ]);
  // Start is drawn over the card on hover or focus only; the title row keeps no room for it.
  const row = lane("Start now").querySelector(".planning-outcome-title-row")!;
  expect(row.querySelector(".planning-full-title-text")!.textContent).toBe(
    "Quarterly report draft",
  );
  expect(row.children).toHaveLength(1);
  const start = screen.getByRole("button", {
    name: "Start: Quarterly report draft",
  });
  start.focus();
  fireEvent.click(start);
  await waitFor(() =>
    expect(announced()).toBe("Marked in progress: Quarterly report draft"),
  );
  expect(update.mock.calls[0]).toEqual([
    expect.objectContaining({ id: "draft" }),
    { active: true },
  ]);
  // In progress, it leaves Start now and, with no stage, the board.
  expect(cards("Start now")).toEqual([
    "Submit the expense claim, Work, No priority, Deadline tomorrow, Wed, Oct 14",
  ]);
  // Focus moves in an effect after the commit that says so.
  await waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Start: Submit the expense claim",
    ),
  );
  // A staged card stays in its lane, without the status or its Start.
  fireEvent.click(
    screen.getByRole("button", { name: "Start: Prepare the visa documents" }),
  );
  await waitFor(() =>
    expect(announced()).toBe("Marked in progress: Prepare the visa documents"),
  );
  expect(cards("Committed")).toContain(
    "Prepare the visa documents, Work, No priority",
  );
  expect(
    screen.queryByRole("button", { name: "Start: Prepare the visa documents" }),
  ).toBeNull();
});

it("shows Focus's quiet line only for due tasks with nothing planned, and opens Plan's Start now", async () => {
  const actions = createPrototype();
  const { data } = await setup(undefined, actions);
  const onShowStart = vi.fn();
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
    onShowStart,
  };
  const { rerender } = render(<FocusView {...props} />);
  // Research's step is in today's queue, so only the draft, the claim and the visa count.
  const line = screen.getByRole("button", {
    name: "1 past deadline and 2 in their start window, not planned this week",
  });
  expect(line.getAttribute("title")).toBe("Show in Plan");
  fireEvent.click(line);
  expect(onShowStart).toHaveBeenCalledOnce();
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

it("leaves a waiting task past its deadline out of Focus's line, as the board shows it in Waiting", async () => {
  const { data, props } = await setup((data) => {
    data.plan.tasks = data.plan.tasks.filter(
      (task) => !["claim", "visa"].includes(task.id),
    );
    data.plan.tasks.find((task) => task.id === "draft")!.planningFlags = [
      "waiting",
    ];
  });
  const focus = render(
    <FocusView
      plan={data.plan}
      focus={data.focus}
      days={data.days}
      language="en"
      busy={false}
      editTask={vi.fn()}
      complete={vi.fn()}
      onOpenPlan={vi.fn()}
      onTimer={vi.fn()}
      onShowStart={vi.fn()}
    />,
  );
  expect(document.querySelector(".plus-focus-runway")).toBeNull();
  focus.unmount();
  render(<PlanView {...props} />);
  expect(cards("Waiting")).toContainEqual(
    expect.stringMatching(
      /^Quarterly report draft, Work, No priority, .*2 days late/u,
    ),
  );
  expect(screen.queryByRole("region", { name: "Start now" })).toBeNull();
});

it("takes Focus's line to Plan's Review with Start now focused", async () => {
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
  const start = await screen.findByRole("region", { name: "Start now" });
  await waitFor(() => expect(document.activeElement).toBe(start));
  expect(
    screen.getByRole("tab", { name: "Review" }).getAttribute("aria-selected"),
  ).toBe("true");
});

it("takes the line to the first staged card that should start when Start now is empty", async () => {
  const { props } = await setup((data) => {
    data.plan.tasks = data.plan.tasks.filter(
      (task) => !["draft", "claim"].includes(task.id),
    );
  });
  render(<PlanView {...props} showStart />);
  await waitFor(() =>
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Prepare the next research check-in, Work, No priority, 2 days left, Thu, Oct 15",
    ),
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
  const editor = (task: PlanningTask) => (
    <TaskEditor
      key={task.planningFlags?.join()}
      task={task}
      tasks={data.plan.tasks}
      dependencies={data.plan.dependencies}
      language="en"
      busy={false}
      run={run}
      actions={actions}
      todayTaskIds={[]}
      today={TODAY}
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
  rerender(editor({ ...visa, planningFlags: ["active"] }));
  expect(screen.getByText("In progress · 5 days left")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Not in progress" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update.mock.calls[1]![1]).toEqual({ active: false });
  // No button without a deadline.
  rerender(editor({ ...visa, deadline: "", planningFlags: [] }));
  expect(screen.queryByRole("button", { name: /in progress/iu })).toBeNull();
  await act(async () => {});
});

it("takes a parked task out of Parked when its details save a stage or mark it in progress", async () => {
  const actions = createPrototype();
  const update = vi
    .spyOn(actions, "updateTask")
    .mockImplementation(async (task) => task);
  const { data } = await setup(undefined, actions);
  const garden = data.plan.tasks.find((task) => task.id === "garden")!;
  const visa = data.plan.tasks.find((task) => task.id === "visa")!;
  const run = vi.fn(async (operation: () => Promise<unknown>) => {
    await operation();
    return true;
  });
  const editor = (task: PlanningTask) => (
    <TaskEditor
      key={task.id}
      task={task}
      tasks={data.plan.tasks}
      dependencies={data.plan.dependencies}
      language="en"
      busy={false}
      run={run}
      actions={actions}
      todayTaskIds={[]}
      today={TODAY}
      addFocus={vi.fn()}
      onOpenTask={vi.fn()}
    />
  );
  // The planning row's Save, not the deadline's.
  const saveButton = () =>
    within(
      document.querySelector<HTMLElement>(".plus-editor-planning")!,
    ).getByRole("button", { name: "Save" });
  const save = (stage: string) => {
    fireEvent.change(screen.getByLabelText("Planning"), {
      target: { value: stage },
    });
    fireEvent.click(saveButton());
  };
  const { rerender } = render(editor(garden));
  save("committed");
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update.mock.calls[0]![1]).toEqual({
    stage: "committed",
    parked: false,
  });
  // An area alone leaves it where it is.
  fireEvent.change(screen.getByLabelText("Planning"), {
    target: { value: "none" },
  });
  fireEvent.change(screen.getByLabelText("Work / Personal"), {
    target: { value: "work" },
  });
  fireEvent.click(saveButton());
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update.mock.calls[1]![1]).toEqual({ area: "work" });
  // A task not set aside sends no `parked`.
  rerender(editor(visa));
  save("monthly");
  await waitFor(() => expect(update).toHaveBeenCalledTimes(3));
  expect(update.mock.calls[2]![1]).toEqual({ stage: "monthly" });
  // Marked in progress, a parked task with a deadline leaves Parked as well.
  rerender(editor({ ...garden, deadline: on(9), leadDays: 7 }));
  fireEvent.click(screen.getByRole("button", { name: "Mark in progress" }));
  await waitFor(() => expect(update).toHaveBeenCalledTimes(4));
  expect(update.mock.calls[3]![1]).toEqual({ active: true, parked: false });
  await act(async () => {});
});

it("tells screen readers how to drag in the page's language, on Review and on Week", async () => {
  const { props } = await setup();
  const view = render(<PlanView {...props} language="zh" />);
  const zh = "按空格或回车拿起，方向键移动，空格或回车放下，Esc 取消。";
  const en =
    "Press Space or Enter to pick it up, the arrow keys to move it, Space or Enter to drop it, and Escape to cancel.";
  /** dnd-kit's own instructions, which it adds to the body. */
  const instructions = () =>
    [...document.body.querySelectorAll(":scope > div[id]")].map(
      (element) => element.textContent,
    );
  /** What every handle found by `selector` is described by, and its role. */
  const described = (selector: string) => {
    const handles = [...document.querySelectorAll<HTMLElement>(selector)];
    expect(handles.length).toBeGreaterThan(0);
    const ids = new Set(
      handles.map((handle) => handle.getAttribute("aria-describedby")),
    );
    expect(ids.size).toBe(1);
    const hint = document.getElementById([...ids][0]!)!;
    // In Plan's own tree, which in the page is the handles' shadow root: an ID there cannot
    // name dnd-kit's text in the body.
    expect(hint.closest(".planning-view")).not.toBeNull();
    return [
      hint.textContent,
      new Set(
        handles.map((handle) => handle.getAttribute("aria-roledescription")),
      ),
    ];
  };
  expect(described(".review-drag-handle")).toEqual([zh, new Set(["可拖动"])]);
  // dnd-kit's own English, which names items by their internal IDs, is not used.
  await waitFor(() => expect(instructions()).toContain(zh));
  expect(instructions().join(" ")).not.toMatch(/draggable item/u);
  fireEvent.click(screen.getByRole("tab", { name: "一周安排" }));
  // Steps, quick cards and scheduled steps alike.
  expect(described(".planning-week .planning-drag-handle")).toEqual([
    zh,
    new Set(["可拖动"]),
  ]);
  // Another language is another provider: the handles and dnd-kit's announcements follow it.
  view.rerender(<PlanView {...props} language="en" />);
  expect(described(".planning-week .planning-drag-handle")).toEqual([
    en,
    new Set(["draggable"]),
  ]);
  await waitFor(() => expect(instructions()).toContain(en));
  expect(instructions()).not.toContain(zh);
});

/** The same open editor receiving a refreshed task, as App and the native task tools do. */
async function refreshedEditor() {
  const actions = createPrototype();
  const data = await actions.load();
  const task: PlanningTask = {
    ...data.plan.tasks[0]!,
    stage: "monthly",
    explicitStage: "monthly",
    area: "work",
    deadline: on(10),
    leadDays: 7,
    etag: "before-refresh",
  };
  const update = vi
    .spyOn(actions, "updateTask")
    .mockImplementation(async (value) => value);
  const lead = vi
    .spyOn(actions, "updateLead")
    .mockImplementation(async (value) => value);
  const run = async (operation: () => Promise<unknown>) => {
    await operation();
    return true;
  };
  const editor = (value: PlanningTask) => (
    <TaskEditor
      task={value}
      tasks={data.plan.tasks}
      dependencies={[]}
      language="en"
      busy={false}
      run={run}
      actions={actions}
      todayTaskIds={[]}
      today={TODAY}
      addFocus={vi.fn()}
      onOpenTask={vi.fn()}
    />
  );
  const view = render(editor(task));
  const refresh = (value: PlanningTask) => view.rerender(editor(value));
  return { task, update, lead, refresh };
}

it("refreshes untouched editor fields without creating edits or dropping new-step drafts", async () => {
  const { task, update, lead, refresh } = await refreshedEditor();
  const draft = screen.getByRole("textbox", { name: "Add steps" });
  fireEvent.change(draft, { target: { value: "A synthetic new step" } });
  const latest = {
    ...task,
    stage: "committed" as const,
    explicitStage: "committed" as const,
    area: "personal" as const,
    deadline: on(20),
    leadDays: 3,
    etag: "after-refresh",
  };
  refresh(latest);
  expect((screen.getByLabelText("Planning") as HTMLSelectElement).value).toBe(
    "committed",
  );
  expect(
    (screen.getByLabelText("Work / Personal") as HTMLSelectElement).value,
  ).toBe("personal");
  expect((screen.getByLabelText("Deadline") as HTMLInputElement).value).toBe(
    on(20),
  );
  expect(
    (screen.getByLabelText("Start ahead") as HTMLSelectElement).value,
  ).toBe("3");
  expect((draft as HTMLTextAreaElement).value).toBe("A synthetic new step");
  for (const button of screen.getAllByRole("button", { name: "Save" })) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
  }
  expect(update).not.toHaveBeenCalled();
  expect(lead).not.toHaveBeenCalled();
});

it("keeps local edits on refresh and requires a choice before saving over changed fields", async () => {
  const { task, update, lead, refresh } = await refreshedEditor();
  fireEvent.change(screen.getByLabelText("Planning"), {
    target: { value: "weekly" },
  });
  fireEvent.change(screen.getByLabelText("Deadline"), {
    target: { value: on(20) },
  });
  const latest = {
    ...task,
    stage: "committed" as const,
    explicitStage: "committed" as const,
    area: "personal" as const,
    deadline: on(12),
    leadDays: 3,
    etag: "after-refresh",
  };
  refresh(latest);
  expect((screen.getByLabelText("Planning") as HTMLSelectElement).value).toBe(
    "weekly",
  );
  expect(
    (screen.getByLabelText("Work / Personal") as HTMLSelectElement).value,
  ).toBe("personal");
  expect((screen.getByLabelText("Deadline") as HTMLInputElement).value).toBe(
    on(20),
  );
  expect(
    (screen.getByLabelText("Start ahead") as HTMLSelectElement).value,
  ).toBe("3");
  expect(screen.getAllByRole("alert")).toHaveLength(2);
  for (const button of screen.getAllByRole("button", { name: "Save" })) {
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
  }
  expect(update).not.toHaveBeenCalled();
  expect(lead).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getAllByRole("button", { name: "Use latest values" })[0]!,
  );
  expect((screen.getByLabelText("Planning") as HTMLSelectElement).value).toBe(
    "committed",
  );
  fireEvent.click(screen.getByRole("button", { name: "Keep my changes" }));
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Save" })[1]!);
  await waitFor(() =>
    expect(lead).toHaveBeenCalledExactlyOnceWith(latest, on(20), 3),
  );
  expect(update).not.toHaveBeenCalled();
});

it("saves only edited planning fields after unrelated refreshes and forgets an edit once it is current", async () => {
  const { task, update, refresh } = await refreshedEditor();
  fireEvent.change(screen.getByLabelText("Planning"), {
    target: { value: "weekly" },
  });
  const latest = { ...task, area: "personal" as const, etag: "after-refresh" };
  refresh(latest);
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]!);
  await waitFor(() =>
    expect(update).toHaveBeenCalledExactlyOnceWith(latest, { stage: "weekly" }),
  );
  // A successful write's re-read shows the chosen value; a later external change should follow.
  refresh({
    ...latest,
    stage: "weekly",
    explicitStage: "weekly",
    etag: "saved",
  });
  refresh({
    ...latest,
    stage: "committed",
    explicitStage: "committed",
    etag: "later-change",
  });
  expect((screen.getByLabelText("Planning") as HTMLSelectElement).value).toBe(
    "committed",
  );
  expect(
    (screen.getAllByRole("button", { name: "Save" })[0] as HTMLButtonElement)
      .disabled,
  ).toBe(true);
});

it("starts editing another field from its newly refreshed value", async () => {
  const { task, update, refresh } = await refreshedEditor();
  fireEvent.change(screen.getByLabelText("Planning"), {
    target: { value: "weekly" },
  });
  const latest = { ...task, area: "personal" as const, etag: "after-refresh" };
  refresh(latest);
  // Area was not being edited during the refresh; changing it now starts from Personal.
  fireEvent.change(screen.getByLabelText("Work / Personal"), {
    target: { value: "unassigned" },
  });
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]!);
  await waitFor(() =>
    expect(update).toHaveBeenCalledExactlyOnceWith(latest, {
      stage: "weekly",
      area: "unassigned",
    }),
  );
});
