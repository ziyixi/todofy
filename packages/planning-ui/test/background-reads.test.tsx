import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { TEST_DESTINATION, createPrototype } from "./fixture";
import type { PlusActions, PlusData, PlusSnapshot, View } from "../src/model";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(cleanup);

function mount(
  actions: PlusActions,
  view: View = "plan",
  snapshot?: PlusSnapshot,
  onSnapshot?: (snapshot?: PlusSnapshot) => void,
) {
  return render(
    <App
      destination={TEST_DESTINATION}
      actions={actions}
      view={view}
      language="en"
      onOpenTask={() => {}}
      onSettings={() => {}}
      snapshot={snapshot}
      onSnapshot={onSnapshot}
    />,
  );
}
function moveButtons() {
  return screen.getAllByRole("button", {
    name: /^Move outcome:/u,
  }) as HTMLButtonElement[];
}
function scheduled(date: string, id: string) {
  return document.querySelector(
    `.planning-calendar-day[data-date="${date}"] .planning-calendar-step[data-task-id="${id}"]`,
  );
}
function held(actions: PlusActions) {
  const reads: ((data: PlusData) => void)[] = [];
  const original = actions.load;
  actions.load = vi.fn(
    () => new Promise<PlusData>((resolve) => reads.push(resolve)),
  );
  return { reads, original };
}

it("keeps the board usable during a refresh and never shows an older read over a newer write", async () => {
  const actions = createPrototype();
  mount(actions);
  await screen.findByRole("region", { name: "Committed" });
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  const before = await actions.load();
  const { reads, original } = held(actions);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  expect(document.querySelector(".plus-page-header .plus-spin")).toBeTruthy();
  const remove = screen.getByRole("button", {
    name: "Remove from 2026-10-14: Clear out the old development branch",
  }) as HTMLButtonElement;
  expect(remove.disabled).toBe(false);
  fireEvent.click(remove);
  await waitFor(() => expect(scheduled("2026-10-14", "cleanup")).toBeNull());
  actions.load = original;
  // The read began before the write, so it is discarded and read again.
  await act(async () => reads[0]!(before));
  await waitFor(() =>
    expect(document.querySelector(".plus-page-header .plus-spin")).toBeNull(),
  );
  expect(scheduled("2026-10-14", "cleanup")).toBeNull();
  expect(
    (await actions.load()).days.find((day) => day.date === "2026-10-14")
      ?.taskIds,
  ).toEqual([]);
});

it("shows confirmed queue, deadline and Bet results without reading the week or plan again", async () => {
  const actions = createPrototype();
  const load = vi.spyOn(actions, "load");
  const loadDays = vi.spyOn(actions, "loadDays");
  mount(actions);
  await screen.findByRole("region", { name: "Committed" });
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  fireEvent.click(
    screen.getByRole("button", {
      name: "Remove from 2026-10-12: Check the layout on a phone",
    }),
  );
  await waitFor(() => expect(scheduled("2026-10-12", "layout")).toBeNull());

  fireEvent.click(screen.getByRole("tab", { name: "Review" }));
  fireEvent.click(
    screen.getByRole("button", {
      name: "Prepare the next research check-in, No priority, 2 days left, Thu, Oct 15",
    }),
  );
  const editor = within(screen.getByRole("region", { name: "Steps & timing" }));
  fireEvent.change(editor.getByLabelText("Deadline"), {
    target: { value: "2026-10-30" },
  });
  const save = editor
    .getAllByRole("button", { name: "Save" })
    .find((button) => !(button as HTMLButtonElement).disabled)!;
  fireEvent.click(save);
  await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(true));
  expect(editor.getByText("Start window: Wed, Oct 28")).toBeTruthy();
  fireEvent.click(editor.getByRole("button", { name: "Close" }));

  const goals = within(screen.getByRole("region", { name: "Weekly goals" }));
  fireEvent.click(goals.getByRole("button", { name: /^Edit work goal:/u }));
  const input = goals.getByRole("textbox");
  fireEvent.change(input, { target: { value: "Shown from its answer" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await goals.findByRole("button", {
    name: "Edit work goal: Shown from its answer",
  });
  expect(load).toHaveBeenCalledOnce();
  expect(loadDays).not.toHaveBeenCalled();
});

it("re-reads on returning to the tab only after a minute and without disabling controls", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  const actions = createPrototype();
  const load = vi.spyOn(actions, "load");
  mount(actions);
  await screen.findByRole("region", { name: "Committed" });
  const visible = () =>
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  now.mockReturnValue(1_000_000 + 59_000);
  await visible();
  expect(load).toHaveBeenCalledOnce();
  now.mockReturnValue(1_000_000 + 60_000);
  const { reads, original } = held(actions);
  await visible();
  expect(actions.load).toHaveBeenCalledOnce();
  expect(
    (
      screen.getAllByRole("button", {
        name: /^Move outcome:/u,
      })[0] as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  await act(async () => reads[0]!(await original()));
  await waitFor(() =>
    expect(document.querySelector(".plus-page-header .plus-spin")).toBeNull(),
  );
});

it("keeps a confirmed completion visible but pending until the re-read shows the result", async () => {
  const actions = createPrototype();
  mount(actions, "focus");
  const checkbox = (await screen.findByRole("button", {
    name: "Complete task: Write the introduction",
  })) as HTMLButtonElement;
  const { reads, original } = held(actions);
  fireEvent.click(checkbox);
  await waitFor(() => expect(checkbox.disabled).toBe(true));
  expect(checkbox.getAttribute("aria-label")).toBe(
    "Complete task: Write the introduction, Updating…",
  );
  const block = document.querySelector(
    '.plus-focus-slot[data-task-id="copy"]',
  )!;
  expect(block.querySelector("[aria-busy=true]")).toBeTruthy();
  expect(screen.getByRole("img", { name: "Updating…" })).toBeTruthy();
  expect(
    (
      screen.getByRole("button", {
        name: "Start: Write the introduction",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  // Other steps stay usable while the completion is re-read.
  expect(
    (
      screen.getByRole("button", {
        name: "Complete task: Outline three questions for the check-in",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
  await act(async () => reads[0]!(await original()));
  await waitFor(() =>
    expect(screen.queryByText("Write the introduction")).toBeNull(),
  );
});

it("paints remembered data at once on re-entry and re-reads it in the background", async () => {
  const actions = createPrototype();
  const data = await actions.load();
  const kept = vi.fn();
  const { reads, original } = held(actions);
  render(
    <App
      destination={TEST_DESTINATION}
      actions={actions}
      view="plan"
      language="en"
      onOpenTask={() => {}}
      onSettings={() => {}}
      snapshot={{ data, readAt: 0 }}
      onSnapshot={kept}
    />,
  );
  expect(screen.queryByText("Loading your plan…")).toBeNull();
  const committed = within(screen.getByRole("region", { name: "Committed" }));
  expect(actions.load).toHaveBeenCalledOnce();
  expect(document.querySelector(".plus-page-header .plus-spin")).toBeTruthy();
  // It may predate a completion or midnight, so writes wait for this visit's read.
  expect(moveButtons().every((button) => button.disabled)).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  const fresh = await original();
  fresh.plan.tasks = fresh.plan.tasks.map((task) =>
    task.id === "cleanup" ? { ...task, stage: "committed" } : task,
  );
  await act(async () => reads[0]!(fresh));
  expect(
    committed.getByText("Clear out the old development branch"),
  ).toBeTruthy();
  expect(moveButtons().some((button) => button.disabled)).toBe(false);
  expect(kept).toHaveBeenLastCalledWith({
    data: fresh,
    readAt: expect.any(Number),
  });
});

it("keeps a remembered other week but follows the server's current week after a rollover", async () => {
  const actions = createPrototype();
  const browsed = await actions.load("2026-10-19");
  const ended = await actions.load("2026-10-05");
  ended.plan.week = "2026-10-05";
  const dates = () =>
    [...document.querySelectorAll(".planning-calendar-day")].map((day) =>
      day.getAttribute("data-date"),
    );
  for (const [snapshot, first] of [
    [browsed, "2026-10-19"],
    [ended, "2026-10-12"],
  ] as const) {
    render(
      <App
        destination={TEST_DESTINATION}
        actions={actions}
        view="plan"
        language="en"
        onOpenTask={() => {}}
        onSettings={() => {}}
        snapshot={{ data: snapshot, readAt: 0 }}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Week" }));
    await waitFor(() =>
      expect(document.querySelector(".plus-page-header .plus-spin")).toBeNull(),
    );
    expect(dates()[0]).toBe(first);
    cleanup();
  }
});

it("does not complete a task again from a board remembered before its re-read landed", async () => {
  const actions = createPrototype();
  const complete = vi.spyOn(actions, "completeTask");
  let kept: PlusSnapshot | undefined;
  const keep = (next?: PlusSnapshot) => (kept = next);
  mount(actions, "focus", undefined, keep);
  const checkbox = await screen.findByRole("button", {
    name: "Complete task: Write the introduction",
  });
  const { reads, original } = held(actions);
  await act(async () => fireEvent.click(checkbox));
  expect(complete).toHaveBeenCalledOnce();
  // The owner leaves Plus before the re-read lands, then comes back.
  cleanup();
  mount(actions, "focus", kept, keep);
  const again = screen.getByRole("button", {
    name: "Complete task: Write the introduction",
  }) as HTMLButtonElement;
  expect(again.disabled).toBe(true);
  fireEvent.click(again);
  expect(
    (
      screen.getByRole("button", {
        name: "Start: Write the introduction",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  const fresh = await original();
  for (const read of reads) await act(async () => read(fresh));
  await waitFor(() =>
    expect(screen.queryByText("Write the introduction")).toBeNull(),
  );
  expect(complete).toHaveBeenCalledOnce();
});

it("shows only the error when the first read after re-entry fails, and forgets the remembered board", async () => {
  const actions = createPrototype();
  const data = await actions.load();
  const keep = vi.fn();
  actions.load = vi.fn(async () => {
    throw new Error("Connection expired or revoked. Open connection settings.");
  });
  mount(actions, "plan", { data, readAt: 0 }, keep);
  await screen.findByRole("alert");
  expect(screen.queryByRole("region", { name: "Committed" })).toBeNull();
  // App reports the snapshot from an effect, which can run after the alert renders.
  await waitFor(() => expect(keep).toHaveBeenLastCalledWith(undefined));
});

it("never lets an older overlapping read replace a newer one", async () => {
  const actions = createPrototype();
  mount(actions);
  await screen.findByRole("region", { name: "Committed" });
  const before = await actions.load();
  const { reads, original } = held(actions);
  const refresh = screen.getByRole("button", { name: "Refresh" });
  fireEvent.click(refresh);
  fireEvent.click(refresh);
  expect(reads).toHaveLength(2);
  // Another device commits a task between the two reads; the newer read lands first.
  const newer = await original();
  newer.plan.tasks = newer.plan.tasks.map((task) =>
    task.id === "cleanup" ? { ...task, stage: "committed" } : task,
  );
  await act(async () => reads[1]!(newer));
  await act(async () => reads[0]!(before));
  expect(
    within(screen.getByRole("region", { name: "Committed" })).getByText(
      "Clear out the old development branch",
    ),
  ).toBeTruthy();
});

it("keeps writes disabled after a label mapping until the re-read brings the new task etags", async () => {
  const actions = createPrototype();
  mount(actions);
  await screen.findByRole("region", { name: "Committed" });
  const { reads, original } = held(actions);
  // The header icon and the toolbar both open the one labels dialog.
  fireEvent.click(
    screen.getAllByRole("button", { name: "Planning labels" })[0]!,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(reads).toHaveLength(1));
  expect(moveButtons().every((button) => button.disabled)).toBe(true);
  await act(async () => reads[0]!(await original()));
  expect(moveButtons().some((button) => button.disabled)).toBe(false);
});
