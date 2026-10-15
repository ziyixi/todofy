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
import type { PlanningTask, PlusActions } from "../src/model";

// jsdom has no layout for real pointer drags (covered by the packaged browser tests), so this
// stand-in hands each drop straight to the board's own onDragEnd.
type Drop = (event: {
  canceled: boolean;
  operation: {
    source?: { data?: Record<string, unknown> };
    target?: { data?: Record<string, unknown> };
  };
}) => void;
const drops = vi.hoisted(() => ({ latest: undefined as Drop | undefined }));
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
  useDroppable: () => ({ ref: () => {}, isDropTarget: false }),
}));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
});
afterEach(cleanup);

/** Holds one action's calls until the test answers them. */
function hold<Name extends "updateTask" | "moveTaskToDay" | "updateQueue">(
  actions: PlusActions,
  name: Name,
) {
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
  await drop({ task: cleanupTask }, { stage: "committed" });
  const committed = within(screen.getByRole("region", { name: "Committed" }));
  const card = committed
    .getByText("Clear out the old development branch")
    .closest<HTMLElement>(".review-draggable")!;
  expect(card.getAttribute("aria-busy")).toBe("true");
  expect(within(card).getByRole("img", { name: "Updating…" })).toBeTruthy();
  expect(
    (
      within(card).getByRole("button", {
        name: /^Move outcome:/u,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  // Only that card waits; the board and the next drag stay available.
  expect(
    (
      screen.getAllByRole("button", {
        name: /^Move outcome:/u,
      }) as HTMLButtonElement[]
    ).filter((button) => !button.disabled).length,
  ).toBeGreaterThan(0);
  expect(
    (screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(writes).toHaveLength(1);
  await act(() => writes[0]!.confirm());
  expect(card.isConnected).toBe(true);
  expect(card.getAttribute("aria-busy")).toBeNull();
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
      "Synthetic write failed",
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
  const queue = hold(actions, "updateQueue");
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
  const staged = predictStage("tools", "committed")(data);
  const changed = (tasks: PlanningTask[]) =>
    tasks.filter((task, index) => task !== data.plan.tasks[index]);
  expect(changed(staged.plan.tasks)).toEqual([
    {
      ...data.plan.tasks.find((task) => task.id === "tools")!,
      stage: "committed",
    },
  ]);
});
