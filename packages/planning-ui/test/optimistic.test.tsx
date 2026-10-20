import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { createPrototype } from "./fixture";
import { predictMove, predictStage } from "../src/plan-updates";
import type { PlanningTask, PlusActions, PlusData } from "../src/model";

// jsdom has no layout for real pointer drags (covered by the packaged browser tests), so this
// stand-in hands each drop straight to the board's own onDragEnd.
type Drop = (event: {
  canceled: boolean;
  operation: {
    source?: { data?: Record<string, unknown> };
    target?: { data?: Record<string, unknown> };
  };
}) => void;
type Sortable = {
  accept?: string | ((source: { data?: Record<string, unknown> }) => boolean);
  data?: Record<string, unknown>;
  plugins?: unknown[];
};
const drops = vi.hoisted(() => ({
  latest: undefined as Drop | undefined,
  // The latest options of each drop target, and of each sortable card, by ID.
  targets: new Map<
    string,
    { disabled?: boolean; data?: Record<string, unknown> }
  >(),
  sortables: new Map<string, Sortable>(),
}));
vi.mock("@dnd-kit/react", () => ({
  DragDropProvider: ({
    children,
    onDragEnd,
  }: {
    children: ReactNode;
    onDragEnd: Drop;
  }) => {
    drops.latest = onDragEnd;
    return children;
  },
  DragOverlay: () => null,
  useDraggable: () => ({
    ref: () => {},
    handleRef: () => {},
    isDragSource: false,
  }),
  useDroppable: (input: {
    id: string;
    disabled?: boolean;
    data?: Record<string, unknown>;
  }) => {
    drops.targets.set(input.id, input);
    return { ref: () => {}, isDropTarget: false };
  },
  useDragOperation: () => ({ source: null, target: null }),
}));
vi.mock("@dnd-kit/react/sortable", () => ({
  useSortable: (input: Sortable & { id: string }) => {
    drops.sortables.set(input.id, input);
    return { ref: () => {}, handleRef: () => {}, isDragSource: false };
  },
}));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
});
afterEach(cleanup);

/** Holds one action's calls until the test answers them. */
function hold<
  Name extends
    | "updateTask"
    | "moveTaskToDay"
    | "addToDay"
    | "removeFromDay"
    | "reorderTasks",
>(actions: PlusActions, name: Name) {
  const original = actions[name] as (...args: unknown[]) => Promise<unknown>;
  const calls: {
    args: unknown[];
    confirm: () => Promise<void>;
    fail: () => void;
  }[] = [];
  actions[name] = vi.fn(
    (...args: unknown[]) =>
      new Promise((resolve, reject) =>
        calls.push({
          args,
          confirm: async () => resolve(await original(...args)),
          fail: () => reject(new Error("Synthetic write failed")),
        }),
      ),
  ) as PlusActions[Name];
  return calls;
}
async function mountPlan(actions: PlusActions) {
  render(
    <App
      actions={actions}
      view="plan"
      language="en"
      onOpenTask={() => {}}
      onSettings={() => {}}
    />,
  );
  await screen.findByRole("region", { name: "Committed" });
}
/** Drops, then lets the write queue start the next write. */
async function drop(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
) {
  await act(async () =>
    drops.latest!({
      canceled: false,
      operation: { source: { data: source }, target: { data: target } },
    }),
  );
}
function day(date: string) {
  return document.querySelector<HTMLElement>(
    `.planning-calendar-day[data-date="${date}"]`,
  )!;
}
function ids(date: string) {
  return [...day(date).querySelectorAll(".planning-calendar-step")].map(
    (card) => card.getAttribute("data-task-id"),
  );
}

it("shows a stage drag at once as one pending card, then the confirmed task", async () => {
  const actions = createPrototype();
  const writes = hold(actions, "updateTask");
  await mountPlan(actions);
  const cleanupTask = (await actions.load()).plan.tasks.find(
    (task) => task.id === "cleanup",
  )!;
  await drop({ task: cleanupTask, lane: "weekly" }, { lane: "committed" });
  const committed = within(screen.getByRole("region", { name: "Committed" }));
  const card = committed
    .getByText("Clear out the old development branch")
    .closest<HTMLElement>(".review-draggable")!;
  expect(card.getAttribute("aria-busy")).toBe("true");
  expect(within(card).getByRole("img", { name: "Updating…" })).toBeTruthy();
  // Screen readers hear that it waits; its handle cannot drag but keeps keyboard focus.
  expect(
    within(card).getByRole("button", {
      name: "Clear out the old development branch, Work, No priority, Updating…",
    }),
  ).toBeTruthy();
  const handle = within(card).getByRole("button", {
    name: "Move outcome: Clear out the old development branch, Updating…",
  }) as HTMLButtonElement;
  expect(handle.getAttribute("aria-disabled")).toBe("true");
  expect(handle.disabled).toBe(false);
  // Only that card waits; the board and the next drag stay available.
  expect(
    (
      screen.getAllByRole("button", {
        name: /^Move outcome:/u,
      }) as HTMLButtonElement[]
    ).filter(
      (button) => !button.disabled && !button.hasAttribute("aria-disabled"),
    ).length,
  ).toBeGreaterThan(0);
  expect(
    (screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(writes).toHaveLength(1);
  await act(() => writes[0]!.confirm());
  expect(card.isConnected).toBe(true);
  expect(card.getAttribute("aria-busy")).toBeNull();
  expect(handle.hasAttribute("aria-disabled")).toBe(false);
  expect(
    within(screen.getByRole("region", { name: "Week" })).queryByText(
      "Clear out the old development branch",
    ),
  ).toBeNull();
});

it("queues day drags in order and rolls back every pending change when one fails", async () => {
  const actions = createPrototype();
  const moves = hold(actions, "moveTaskToDay");
  const load = vi.spyOn(actions, "load");
  await mountPlan(actions);
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  await drop(
    { taskId: "layout", sourceDate: "2026-10-12" },
    { date: "2026-10-15" },
  );
  await drop(
    { taskId: "cleanup", sourceDate: "2026-10-14" },
    {
      date: "2026-10-15",
      beforeId: "layout",
    },
  );
  // Both drags show at once; FlowDay sees them strictly one after another.
  expect(ids("2026-10-15")).toEqual(["cleanup", "layout"]);
  expect(ids("2026-10-12")).toEqual([]);
  expect(day("2026-10-15").querySelectorAll("[aria-busy=true]")).toHaveLength(
    2,
  );
  expect(moves).toHaveLength(1);
  await act(() => moves[0]!.confirm());
  await waitFor(() => expect(moves).toHaveLength(2));
  expect(ids("2026-10-15")).toEqual(["cleanup", "layout"]);
  expect(day("2026-10-15").querySelectorAll("[aria-busy=true]")).toHaveLength(
    1,
  );

  await drop(
    { taskId: "copy", sourceDate: "2026-10-13" },
    { date: "2026-10-16" },
  );
  expect(ids("2026-10-16")).toEqual(["copy"]);
  await act(async () => moves[1]!.fail());
  // The failed drag and the one queued behind it both roll back; the earlier one stays.
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "Change not saved; restored. Synthetic write failed Later changes not sent: 1",
    ),
  );
  expect(ids("2026-10-15")).toEqual(["layout"]);
  expect(ids("2026-10-16")).toEqual([]);
  expect(ids("2026-10-13")).toContain("copy");
  expect(moves).toHaveLength(2);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(document.querySelectorAll("[aria-busy=true]")).toHaveLength(0);
});

it("keeps a removed card in place and pending until FlowDay confirms the removal", async () => {
  const actions = createPrototype();
  const queue = hold(actions, "removeFromDay");
  await mountPlan(actions);
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  const remove = screen.getByRole("button", {
    name: "Remove from 2026-10-14: Clear out the old development branch",
  }) as HTMLButtonElement;
  await act(async () => fireEvent.click(remove));
  const card = day("2026-10-14").querySelector('[data-task-id="cleanup"]')!;
  expect(card.getAttribute("aria-busy")).toBe("true");
  expect(remove.disabled).toBe(true);
  expect(
    (
      screen.getByRole("button", {
        name: "Remove from 2026-10-12: Check the layout on a phone",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  await act(() => queue[0]!.confirm());
  expect(ids("2026-10-14")).toEqual([]);
});

it("predicts moves like moveTaskToDay, including today's Focus queue, and stage changes by ID", async () => {
  const data = await createPrototype().load();
  const moved = predictMove(
    "layout",
    "2026-10-12",
    "2026-10-13",
    "outline",
  )(data);
  expect(
    moved.days.find((item) => item.date === "2026-10-12")?.taskIds,
  ).toEqual([]);
  expect(moved.focus.taskIds).toEqual(["copy", "layout", "outline", "receipt"]);
  const reordered = predictMove("receipt", "2026-10-13", "2026-10-13")(moved);
  expect(reordered.focus.taskIds).toEqual([
    "copy",
    "layout",
    "outline",
    "receipt",
  ]);
  const added = predictMove(
    "measure",
    undefined,
    "2026-10-14",
    "missing",
  )(data);
  expect(
    added.days.find((item) => item.date === "2026-10-14")?.taskIds,
  ).toEqual(["cleanup", "measure"]);
  // A stage drag shows the saved stage at once; from Start now also in progress, after which the
  // task no longer needs to start. Tags are left alone.
  const tools = data.plan.tasks.find((task) => task.id === "tools")!;
  const changed = (tasks: PlanningTask[]) =>
    tasks.filter((task, index) => task !== data.plan.tasks[index]);
  const staged = predictStage("tools", "committed")(data);
  expect(changed(staged.plan.tasks)).toEqual([
    { ...tools, stage: "committed", explicitStage: "committed" },
  ]);
  const started = predictStage("tools", "weekly", true)(data);
  expect(changed(started.plan.tasks)).toEqual([
    {
      ...tools,
      stage: "weekly",
      explicitStage: "weekly",
      planningFlags: ["active"],
      mustStart: false,
      missingLead: false,
    },
  ]);
});

function removeFrom(date: string, title: string) {
  return screen.getByRole("button", {
    name: `Remove from ${date}: ${title}`,
  }) as HTMLButtonElement;
}
async function serverDay(actions: PlusActions, date: string) {
  return (await actions.loadDays("2026-10-12")).find((day) => day.date === date)
    ?.taskIds;
}

it("removes two steps from one day in quick succession without restoring the first", async () => {
  const actions = createPrototype();
  await mountPlan(actions);
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  // The second removal is queued while the first card still waits in place.
  fireEvent.click(removeFrom("2026-10-13", "Write the introduction"));
  fireEvent.click(
    removeFrom("2026-10-13", "Outline three questions for the check-in"),
  );
  await waitFor(() => expect(ids("2026-10-13")).toEqual(["receipt"]));
  expect(await serverDay(actions, "2026-10-13")).toEqual(["receipt"]);
});

it("adds to today while a removal from today waits, keeping the removal", async () => {
  const actions = createPrototype();
  const removals = hold(actions, "removeFromDay");
  await mountPlan(actions);
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  await act(async () =>
    fireEvent.click(removeFrom("2026-10-13", "Write the introduction")),
  );
  fireEvent.click(screen.getByRole("tab", { name: "Review" }));
  fireEvent.click(
    screen.getByRole("button", {
      name: "Make the home desk comfortable, Personal, No priority",
    }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "Add to today: Measure the desk for a new lamp",
    }),
  );
  await act(() => removals[0]!.confirm());
  await waitFor(() =>
    expect(
      screen.getByRole("button", {
        name: "In today: Measure the desk for a new lamp",
      }),
    ).toBeTruthy(),
  );
  expect(await serverDay(actions, "2026-10-13")).toEqual([
    "outline",
    "receipt",
    "measure",
  ]);
});

it("keeps a step another tab added to a shown day when a step is removed from it", async () => {
  const actions = createPrototype();
  await mountPlan(actions);
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  // FlowDay in another tab; this board has not read the day again.
  await actions.addToDay("layout", "2026-10-13");
  fireEvent.click(removeFrom("2026-10-13", "Write the introduction"));
  await waitFor(() =>
    expect(ids("2026-10-13")).toEqual(["outline", "receipt", "layout"]),
  );
  expect(await serverDay(actions, "2026-10-13")).toEqual([
    "outline",
    "receipt",
    "layout",
  ]);
});

it("keeps a pending card's details read-only until its drag settles, and the Bets editable", async () => {
  const actions = createPrototype();
  const writes = hold(actions, "updateTask");
  await mountPlan(actions);
  const release = (await actions.load()).plan.tasks.find(
    (task) => task.id === "release",
  )!;
  await drop({ task: release, lane: "committed" }, { lane: "weekly" });
  const goals = within(screen.getByRole("region", { name: "Weekly goals" }));
  // A Bet is text tied to no task, so a pending drag holds none of its writes.
  expect(
    (
      goals.getByRole("button", {
        name: /^Edit work goal:/u,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  fireEvent.click(
    screen.getByRole("button", {
      name: "Ship the small website refresh, Work, No priority, Updating…",
    }),
  );
  const editor = () =>
    within(screen.getByRole("region", { name: "Steps & timing" }));
  const planning = () =>
    editor().getByRole("combobox", { name: "Planning" }) as HTMLSelectElement;
  const saves = () =>
    editor()
      .getAllByRole("button", { name: "Save" })
      .map((button) => (button as HTMLButtonElement).disabled);
  expect(editor().getByRole("img", { name: "Updating…" })).toBeTruthy();
  expect(planning().disabled).toBe(true);
  expect(saves()).toEqual([true, true]);
  await act(async () => writes[0]!.fail());
  // The drag was not saved: the details show the stage the server kept, with nothing to save.
  await waitFor(() => expect(planning().disabled).toBe(false));
  expect(planning().value).toBe("committed");
  expect(editor().queryByRole("img", { name: "Updating…" })).toBeNull();
  expect(saves()).toEqual([true, true]);
  expect(screen.getByRole("alert").textContent).toContain(
    "Change not saved; restored. Synthetic write failed",
  );
});

it("keeps a pending card's Start disabled until its drag settles", async () => {
  const actions = createPrototype();
  const writes = hold(actions, "updateTask");
  await mountPlan(actions);
  const research = (await actions.load()).plan.tasks.find(
    (task) => task.id === "research",
  )!;
  const start = () =>
    screen.getByRole("button", {
      name: "Start: Prepare the next research check-in",
    }) as HTMLButtonElement;
  expect(start().disabled).toBe(false);
  await drop({ task: research, lane: "committed" }, { lane: "weekly" });
  // Its etag is the one from before the drag, so the write would be refused.
  expect(start().disabled).toBe(true);
  await act(async () => writes[0]!.confirm());
  await waitFor(() => expect(start().disabled).toBe(false));
});

/** The cards of a lane, by title. */
function laneTitles(name: string) {
  return within(screen.getByRole("region", { name }))
    .queryAllByRole("button", { name: /, (No priority|P\d)/u })
    .map((card) => card.getAttribute("aria-label")!.split(",")[0]);
}

it("acknowledges a Start now card by dragging it into a stage lane: its stage and in progress in one write", async () => {
  // The full preview board has two tasks in Start now.
  const actions = createPrototype(true);
  const writes = hold(actions, "updateTask");
  await mountPlan(actions);
  expect(laneTitles("Start now")).toEqual([
    "Renew the passport",
    "Submit the travel expense claim",
  ]);
  const claim = (await actions.load()).plan.tasks.find(
    (task) => task.id === "claim",
  )!;
  await drop({ task: claim, lane: "start" }, { lane: "committed" });
  expect(writes.map((write) => write.args[1])).toEqual([
    { stage: "committed", active: true },
  ]);
  // Shown at once in its lane and waiting there; Start now keeps only the other card.
  expect(laneTitles("Start now")).toEqual(["Renew the passport"]);
  const card = within(screen.getByRole("region", { name: "Committed" }))
    .getByText("Submit the travel expense claim")
    .closest<HTMLElement>(".review-draggable")!;
  expect(card.getAttribute("aria-busy")).toBe("true");
  // In progress, it no longer says it should start.
  expect(card.querySelector(".planning-outcome-status")).toBeNull();
  await act(() => writes[0]!.confirm());
  expect(card.getAttribute("aria-busy")).toBeNull();
  expect(laneTitles("Committed")).toContain("Submit the travel expense claim");
  // The last Start now card leaves the lane, which is then hidden.
  const passport = (await actions.load()).plan.tasks.find(
    (task) => task.id === "passport",
  )!;
  await drop({ task: passport, lane: "start" }, { lane: "weekly" });
  expect(screen.queryByRole("region", { name: "Start now" })).toBeNull();
  // A failed write puts the card back where it was.
  await act(async () => writes[1]!.fail());
  expect(laneTitles("Start now")).toEqual(["Renew the passport"]);
  expect(screen.getByRole("alert").textContent).toContain(
    "Change not saved; restored.",
  );
});

it("moves a Waiting card into a stage lane with its stage only, still waiting", async () => {
  const actions = createPrototype();
  const writes = hold(actions, "updateTask");
  await mountPlan(actions);
  const venue = (await actions.load()).plan.tasks.find(
    (task) => task.id === "venue",
  )!;
  await drop({ task: venue, lane: "waiting" }, { lane: "weekly" });
  expect(writes.map((write) => write.args[1])).toEqual([{ stage: "weekly" }]);
  expect(laneTitles("Week")).toContain("Hear back about the venue quote");
  expect(laneTitles("Waiting")).toEqual(["Lab access approval"]);
  await act(() => writes[0]!.confirm());
  const saved = (await actions.load()).plan.tasks.find(
    (task) => task.id === "venue",
  )!;
  expect(saved).toMatchObject({
    explicitStage: "weekly",
    planningFlags: ["waiting"],
  });
  // In its stage lane the card still says it waits.
  expect(
    within(screen.getByRole("region", { name: "Week" }))
      .getByRole("button", { name: /^Hear back about the venue quote,/u })
      .getAttribute("aria-label"),
  ).toMatch(
    /^Hear back about the venue quote, Work, No priority, No change in \d+ days$/u,
  );
});

/** Two steps of the committed research check-in: one waits, one should start. */
function withResearchSteps(
  actions: PlusActions,
  change?: (data: PlusData) => void,
) {
  const load = actions.load.bind(actions);
  vi.spyOn(actions, "load").mockImplementation(async (week) => {
    const data = await load(week);
    const outline = data.plan.tasks.find((task) => task.id === "outline")!;
    data.plan.tasks.push(
      {
        ...outline,
        id: "reply",
        title: "Hear back from the reviewer",
        planningFlags: ["waiting"],
      },
      {
        ...outline,
        id: "slides",
        title: "Draft the check-in slides",
        deadline: "2026-10-14",
        leadDays: 3,
        mustStart: true,
      },
    );
    change?.(data);
    return data;
  });
}

it("writes nothing for a step dropped into its outcome's lane, where it would come straight back", async () => {
  const actions = createPrototype();
  withResearchSteps(actions);
  const writes = hold(actions, "updateTask");
  await mountPlan(actions);
  const step = async (id: string) =>
    (await actions.load()).plan.tasks.find((task) => task.id === id)!;
  expect(laneTitles("Waiting")).toContain("Hear back from the reviewer");
  // Committed, it would still be a step of the research card, so it would still wait.
  await drop(
    { task: await step("reply"), lane: "waiting" },
    { lane: "committed" },
  );
  expect(writes).toHaveLength(0);
  expect(laneTitles("Waiting")).toContain("Hear back from the reviewer");
  // Marked in progress as well, the step that should start does leave Start now.
  expect(laneTitles("Start now")).toEqual(["Draft the check-in slides"]);
  await drop(
    { task: await step("slides"), lane: "start" },
    { lane: "committed" },
  );
  expect(writes.map((write) => write.args[1])).toEqual([
    { stage: "committed", active: true },
  ]);
  expect(screen.queryByRole("region", { name: "Start now" })).toBeNull();
  // Into another stage, the waiting step becomes a card of its own there, queued after the first.
  await drop(
    { task: await step("reply"), lane: "waiting" },
    { lane: "weekly" },
  );
  expect(laneTitles("Week")).toContain("Hear back from the reviewer");
  expect(laneTitles("Waiting")).not.toContain("Hear back from the reviewer");
});

/** `change` edits each read. */
function withParked(actions: PlusActions, change?: (data: PlusData) => void) {
  const load = actions.load.bind(actions);
  vi.spyOn(actions, "load").mockImplementation(async (week) => {
    const data = await load(week);
    change?.(data);
    return data;
  });
}

it("sets a card aside by dragging it into Parked, and takes one out into a stage lane", async () => {
  const actions = createPrototype();
  withParked(actions);
  const writes = hold(actions, "updateTask");
  await mountPlan(actions);
  const task = async (id: string) =>
    (await actions.load()).plan.tasks.find((item) => item.id === id)!;
  expect(laneTitles("Parked")).toEqual(["Plan a small balcony garden"]);
  await drop({ task: await task("tools"), lane: "weekly" }, { lane: "parked" });
  // Set aside alone: Todofy takes the stage off with it.
  expect(writes.map((write) => write.args[1])).toEqual([{ parked: true }]);
  const card = within(screen.getByRole("region", { name: "Parked" }))
    .getByText("Try the new charting library")
    .closest<HTMLElement>(".review-draggable")!;
  expect(card.getAttribute("aria-busy")).toBe("true");
  expect(laneTitles("Week")).not.toContain("Try the new charting library");
  await act(() => writes[0]!.confirm());
  expect(laneTitles("Parked")).toEqual([
    "Plan a small balcony garden",
    "Try the new charting library",
  ]);
  // Out of Parked into a stage lane: that stage, and no longer set aside.
  await drop(
    { task: await task("garden"), lane: "parked" },
    { lane: "monthly" },
  );
  expect(writes[1]!.args[1]).toEqual({ stage: "monthly", parked: false });
  expect(laneTitles("Month")).toContain("Plan a small balcony garden");
  await act(() => writes[1]!.confirm());
  expect(await task("garden")).toMatchObject({
    explicitStage: "monthly",
    planningFlags: [],
  });
  // Waiting takes no drops, from Parked as from anywhere.
  await drop(
    { task: await task("tools"), lane: "parked" },
    { lane: "waiting" },
  );
  expect(writes).toHaveLength(2);
  expect(laneTitles("Parked")).toEqual(["Try the new charting library"]);
});

it("writes nothing for a parked step dropped into its outcome's lane, where it would be a step again", async () => {
  const actions = createPrototype();
  withParked(actions, (data) => {
    data.plan.tasks.find((task) => task.id === "outline")!.planningFlags = [
      "parked",
    ];
  });
  const writes = hold(actions, "updateTask");
  await mountPlan(actions);
  const outline = (await actions.load()).plan.tasks.find(
    (task) => task.id === "outline",
  )!;
  expect(laneTitles("Parked")).toContain(
    "Outline three questions for the check-in",
  );
  await drop({ task: outline, lane: "parked" }, { lane: "committed" });
  expect(writes).toHaveLength(0);
  expect(laneTitles("Parked")).toContain(
    "Outline three questions for the check-in",
  );
  // Into another stage it becomes a card of its own there.
  await drop({ task: outline, lane: "parked" }, { lane: "weekly" });
  expect(writes.map((write) => write.args[1])).toEqual([
    { stage: "weekly", parked: false },
  ]);
  expect(laneTitles("Week")).toContain(
    "Outline three questions for the check-in",
  );
});

it("plans a quick task by dropping its card into a day, exactly as a step", async () => {
  const actions = createPrototype();
  const load = actions.load.bind(actions);
  vi.spyOn(actions, "load").mockImplementation(async (week) => {
    const data = await load(week);
    const receipt = data.plan.tasks.find((task) => task.id === "receipt")!;
    data.plan.tasks.push({
      ...receipt,
      id: "renew",
      title: "Renew the library card",
    });
    return data;
  });
  const moves = hold(actions, "moveTaskToDay");
  await mountPlan(actions);
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  const quick = screen.getByRole("region", { name: "Quick tasks" });
  expect(
    within(quick).getByRole("button", {
      name: "Renew the library card, Work",
    }),
  ).toBeTruthy();
  await drop(
    { taskId: "renew", title: "Renew the library card" },
    { date: "2026-10-15", beforeId: undefined },
  );
  expect(moves.map((move) => move.args)).toEqual([
    [
      "renew",
      undefined,
      expect.objectContaining({ date: "2026-10-15" }),
      undefined,
    ],
  ]);
  expect(ids("2026-10-15")).toEqual(["renew"]);
  expect(day("2026-10-15").querySelector("[aria-busy=true]")).toBeTruthy();
  await act(() => moves[0]!.confirm());
  // In the calendar now, it leaves the Quick line, which then has nothing to show.
  expect(screen.queryByRole("region", { name: "Quick tasks" })).toBeNull();
});

/** A Review card's drag data, as its sortable has it now. */
function cardData(id: string) {
  return drops.sortables.get(`review-outcome:${id}`)!.data!;
}

it("reorders a card inside its lane at once, with one ReorderTasks of the whole lane", async () => {
  const actions = createPrototype();
  const reorders = hold(actions, "reorderTasks");
  const updates = hold(actions, "updateTask");
  await mountPlan(actions);
  expect(laneTitles("Committed")).toEqual([
    "Ship the small website refresh",
    "Prepare the next research check-in",
    "Organize the experiment notes",
    "Make the home desk comfortable",
  ]);
  // Arrow keys step from card to card, and dnd-kit's optimistic sorting never moves the DOM.
  expect(drops.sortables.get("review-outcome:research")!.plugins).toHaveLength(
    1,
  );
  // Dropped on the desk's card, the research card takes its place.
  await drop(cardData("research"), cardData("desk"));
  expect(reorders.map((call) => call.args)).toEqual([
    [
      ["release", "notes", "desk", "research"],
      "research",
      "committed",
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
    ],
  ]);
  expect(laneTitles("Committed")).toEqual([
    "Ship the small website refresh",
    "Organize the experiment notes",
    "Make the home desk comfortable",
    "Prepare the next research check-in",
  ]);
  const card = within(screen.getByRole("region", { name: "Committed" }))
    .getByText("Prepare the next research check-in")
    .closest<HTMLElement>(".review-draggable")!;
  expect(card.getAttribute("aria-busy")).toBe("true");
  // Not saved: it goes back, and the same move again is the same request.
  await act(async () => reorders[0]!.fail());
  await waitFor(() =>
    expect(laneTitles("Committed")[1]).toBe(
      "Prepare the next research check-in",
    ),
  );
  await drop(cardData("research"), cardData("desk"));
  expect(reorders[1]!.args).toEqual(reorders[0]!.args);
  await act(() => reorders[1]!.confirm());
  expect(laneTitles("Committed").at(-1)).toBe(
    "Prepare the next research check-in",
  );
  expect(card.getAttribute("aria-busy")).toBeNull();
  // Week's overview follows the lane's order.
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  expect(
    [
      ...document.querySelectorAll(
        ".planning-commitment-grid .planning-outcome-card",
      ),
    ].map((item) => item.getAttribute("data-outcome-id")),
  ).toEqual(["release", "notes", "desk", "research"]);
  expect(updates).toHaveLength(0);
});

it("moves nothing for a drop on its own lane or its own place, and stages a drop on another lane's card", async () => {
  const actions = createPrototype();
  const reorders = hold(actions, "reorderTasks");
  const updates = hold(actions, "updateTask");
  await mountPlan(actions);
  await drop(cardData("research"), { lane: "committed", stage: "committed" });
  await drop(cardData("research"), cardData("research"));
  expect(reorders).toHaveLength(0);
  // On a card of Week, it takes Week's stage, as on the lane.
  await drop(cardData("research"), cardData("cleanup"));
  expect(updates.map((call) => call.args[1])).toEqual([{ stage: "weekly" }]);
  expect(reorders).toHaveLength(0);
});

it("sends the whole lane's order when an area filter hides some of its cards", async () => {
  const actions = createPrototype();
  const reorders = hold(actions, "reorderTasks");
  await mountPlan(actions);
  fireEvent.click(screen.getByRole("tab", { name: "Work" }));
  expect(laneTitles("Committed")).toHaveLength(3);
  await drop(cardData("notes"), cardData("release"));
  expect(reorders[0]!.args.slice(0, 3)).toEqual([
    ["notes", "release", "research", "desk"],
    "notes",
    "committed",
  ]);
});

it("lets Start now and Waiting cards take only their own lane's cards", async () => {
  const actions = createPrototype(true);
  await mountPlan(actions);
  const accepts = (id: string, lane: string) => {
    const accept = drops.sortables.get(`review-outcome:${id}`)!.accept!;
    return typeof accept === "function"
      ? accept({ data: { lane } })
      : accept === "review-outcome";
  };
  for (const [id, lane] of [
    ["claim", "start"],
    ["venue", "waiting"],
  ] as const)
    expect(
      ["start", "waiting", "weekly", "committed"].filter((from) =>
        accepts(id, from),
      ),
    ).toEqual([lane]);
  expect(accepts("cleanup", "start")).toBe(true);
});

/** The website refresh with a third child that has a step of its own, so it is no leaf. */
function withNestedStep(actions: PlusActions) {
  const load = actions.load.bind(actions);
  vi.spyOn(actions, "load").mockImplementation(async (week) => {
    const data = await load(week);
    const copy = data.plan.tasks.find((task) => task.id === "copy")!;
    data.plan.tasks.push(
      { ...copy, id: "assets", title: "Gather the images", childOrder: 3 },
      {
        ...copy,
        id: "crop",
        title: "Crop the hero image",
        parentId: "assets",
        childOrder: 1,
      },
    );
    return data;
  });
}
/** Next steps' titles, in order. */
function trayTitles() {
  return [...document.querySelectorAll(".planning-tray-step")].map(
    (step) =>
      step.querySelector(".planning-step-title .planning-full-title-text")
        ?.textContent,
  );
}

it("reorders a next step among its siblings at once, with one ReorderTasks of the parent's children", async () => {
  const actions = createPrototype();
  withNestedStep(actions);
  const reorders = hold(actions, "reorderTasks");
  const moves = hold(actions, "moveTaskToDay");
  await mountPlan(actions);
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  expect(trayTitles()).toEqual([
    "Write the introduction",
    "Check the layout on a phone",
    "Crop the hero image",
  ]);
  const step = (id: string) => drops.sortables.get(`tray:${id}`)!.data!;
  // A step of another parent is no sibling: nothing is written.
  await drop(step("copy"), step("crop"));
  expect(reorders).toHaveLength(0);
  // Onto its sibling's place: the parent's three children, the one with its own step too.
  await drop(step("copy"), step("layout"));
  expect(reorders.map((call) => call.args)).toEqual([
    [
      ["layout", "copy", "assets"],
      "copy",
      "",
      expect.stringMatching(/^[0-9a-f-]{36}$/u),
    ],
  ]);
  expect(trayTitles()).toEqual([
    "Check the layout on a phone",
    "Write the introduction",
    "Crop the hero image",
  ]);
  const moved = document.querySelector<HTMLElement>(
    '.planning-tray-step[data-task-id="copy"]',
  )!;
  expect(moved.getAttribute("aria-busy")).toBe("true");
  expect(
    within(moved).getByRole("button", {
      name: "Drag step: Write the introduction, Updating…",
    }),
  ).toBeTruthy();
  await act(() => reorders[0]!.confirm());
  expect(moved.getAttribute("aria-busy")).toBeNull();
  expect(trayTitles()[1]).toBe("Write the introduction");
  // A drop on a day still plans the step there.
  await drop(step("layout"), { date: "2026-10-16" });
  expect(moves.map((call) => call.args[0])).toEqual(["layout"]);
});

/** The fixture with this many more tasks like `template`, from `fields`. */
function withMore(
  actions: PlusActions,
  template: string,
  count: number,
  fields: (index: number) => Partial<PlanningTask>,
) {
  const load = actions.load.bind(actions);
  vi.spyOn(actions, "load").mockImplementation(async (week) => {
    const data = await load(week);
    const like = data.plan.tasks.find((task) => task.id === template)!;
    for (let index = 0; index < count; index++)
      data.plan.tasks.push({ ...like, id: `extra-${index}`, ...fields(index) });
    return data;
  });
}

it("keeps at most Todofy's 100 IDs of a lane's order, and writes nothing for a drop past them", async () => {
  const actions = createPrototype();
  // 101 cards in Committed: the fixture's four and 97 more.
  withMore(actions, "desk", 97, (index) => ({
    title: `Synthetic outcome ${index}`,
  }));
  const reorders = hold(actions, "reorderTasks");
  // Only this board's cards.
  drops.sortables.clear();
  await mountPlan(actions);
  const lane = [...drops.sortables.values()]
    .map((sortable) => sortable.data!)
    .filter((data) => data.lane === "committed")
    .sort((a, b) => Number(a.position) - Number(b.position));
  const ids = lane.map((data) => (data.task as PlanningTask).id);
  expect(ids).toHaveLength(101);
  // Within the first 100: the first 100 of the new order.
  await drop(lane[0]!, lane[1]!);
  expect(reorders.map((call) => call.args.slice(0, 3))).toEqual([
    [[ids[1], ids[0], ...ids.slice(2, 100)], ids[0], "committed"],
  ]);
  await act(() => reorders[0]!.confirm());
  // To the 101st place: nothing a request could keep, so nothing is sent.
  await drop(lane[2]!, lane[100]!);
  expect(reorders).toHaveLength(1);
});

it("writes no Next steps order for more than 100 siblings, which one request cannot take", async () => {
  const step = (id: string) => drops.sortables.get(`tray:${id}`)!.data!;
  // The website refresh's two steps and 98 more: 100 siblings, each with its own position.
  for (const [more, sent] of [
    [98, 1],
    [99, 0],
  ] as const) {
    const actions = createPrototype();
    withMore(actions, "copy", more, (index) => ({
      title: `Synthetic step ${index}`,
      childOrder: index + 3,
    }));
    const reorders = hold(actions, "reorderTasks");
    await mountPlan(actions);
    fireEvent.click(screen.getByRole("tab", { name: "Week" }));
    await drop(step("copy"), step("layout"));
    expect(reorders).toHaveLength(sent);
    if (sent) expect(reorders[0]!.args[0]).toHaveLength(100);
    cleanup();
  }
});
