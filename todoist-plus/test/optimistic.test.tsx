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
import { createPrototype } from "../design/fixture";
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
const drops = vi.hoisted(() => ({
  latest: undefined as Drop | undefined,
  // The latest options of each drop target, by ID.
  targets: new Map<
    string,
    { disabled?: boolean; data?: Record<string, unknown> }
  >(),
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
}));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
});
afterEach(cleanup);

/** Holds one action's calls until the test answers them. */
function hold<
  Name extends "updateTask" | "moveTaskToDay" | "addToDay" | "removeFromDay",
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
      name: "Clear out the old development branch, No priority, Updating…",
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
  // A stage drag shows the stage's label in place of the other planning labels, as Todofy writes it;
  // from Start now also the in-progress label, after which the task no longer needs to start.
  const tools = data.plan.tasks.find((task) => task.id === "tools")!;
  const changed = (tasks: PlanningTask[]) =>
    tasks.filter((task, index) => task !== data.plan.tasks[index]);
  const staged = predictStage(
    "tools",
    "committed",
  )({
    ...data,
    plan: {
      ...data.plan,
      tasks: data.plan.tasks.map((task) =>
        task === tools ? { ...tools, labels: ["focus", "office"] } : task,
      ),
    },
  });
  expect(changed(staged.plan.tasks)).toEqual([
    { ...tools, stage: "committed", labels: ["office", "committed"] },
  ]);
  const started = predictStage("tools", "weekly", true)(data);
  expect(changed(started.plan.tasks)).toEqual([
    {
      ...tools,
      stage: "weekly",
      labels: ["focus", "active"],
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
      name: "Make the home desk comfortable, No priority",
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
      name: "Ship the small website refresh, No priority, Updating…",
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

it("moves a Waiting card into a stage lane with its stage only, keeping its waiting label", async () => {
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
  expect(saved.labels).toEqual(["waiting", "office", "focus"]);
  // In its stage lane the card still says it waits.
  expect(
    within(screen.getByRole("region", { name: "Week" }))
      .getByRole("button", { name: /^Hear back about the venue quote,/u })
      .getAttribute("aria-label"),
  ).toMatch(
    /^Hear back about the venue quote, No priority, No change in \d+ days$/u,
  );
});

it("drags Start now with the stage only without the active label; a drop on Start now or Waiting changes nothing", async () => {
  const actions = createPrototype(true);
  const load = actions.load.bind(actions);
  vi.spyOn(actions, "load").mockImplementation(async (week) => {
    const data = await load(week);
    data.plan.availableLabels = data.plan.availableLabels.filter(
      (label) => label.label !== "active",
    );
    return data;
  });
  const writes = hold(actions, "updateTask");
  await mountPlan(actions);
  const claim = (await load()).plan.tasks.find((task) => task.id === "claim")!;
  await drop({ task: claim, lane: "start" }, { lane: "committed" });
  expect(writes.map((write) => write.args[1])).toEqual([
    { stage: "committed" },
  ]);
  // Start now and Waiting catch a card let go over them, with no label: it goes back, unwritten.
  for (const lane of ["start", "waiting"])
    expect(drops.targets.get(`review-lane:${lane}`)).toMatchObject({
      disabled: false,
      data: { stage: undefined },
    });
  const passport = (await load()).plan.tasks.find(
    (task) => task.id === "passport",
  )!;
  await drop({ task: passport, lane: "start" }, { lane: "start" });
  const venue = (await load()).plan.tasks.find((task) => task.id === "venue")!;
  await drop({ task: venue, lane: "waiting" }, { lane: "waiting" });
  expect(writes).toHaveLength(1);
  expect(laneTitles("Start now")).toEqual(["Renew the passport"]);
  expect(laneTitles("Waiting")).toContain("Hear back about the venue quote");
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
        labels: ["waiting"],
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
  // With Committed's label it would still be a step of the research card, so it would still wait.
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

it("writes nothing for a step that should start dropped into its outcome's lane without the active label", async () => {
  const actions = createPrototype();
  withResearchSteps(actions, (data) => {
    data.plan.availableLabels = data.plan.availableLabels.filter(
      (label) => label.label !== "active",
    );
  });
  const writes = hold(actions, "updateTask");
  await mountPlan(actions);
  const slides = (await actions.load()).plan.tasks.find(
    (task) => task.id === "slides",
  )!;
  await drop({ task: slides, lane: "start" }, { lane: "committed" });
  expect(writes).toHaveLength(0);
  expect(laneTitles("Start now")).toEqual(["Draft the check-in slides"]);
});

/** The account has a label named parked, so Review has its Parked lane; `change` edits each read. */
function withParked(actions: PlusActions, change?: (data: PlusData) => void) {
  const load = actions.load.bind(actions);
  vi.spyOn(actions, "load").mockImplementation(async (week) => {
    const data = await load(week);
    data.plan.availableLabels.push({ id: "synthetic-parked", label: "parked" });
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
  // The set-aside label alone: Todofy takes the planning labels off with it.
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
  // Out of Parked into a stage lane: that stage, and the label goes.
  await drop(
    { task: await task("garden"), lane: "parked" },
    { lane: "monthly" },
  );
  expect(writes[1]!.args[1]).toEqual({ stage: "monthly", parked: false });
  expect(laneTitles("Month")).toContain("Plan a small balcony garden");
  await act(() => writes[1]!.confirm());
  expect((await task("garden")).labels).toEqual(["home", "candiate"]);
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
    data.plan.tasks.find((task) => task.id === "outline")!.labels = ["parked"];
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
    within(quick).getByRole("button", { name: "Renew the library card" }),
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
