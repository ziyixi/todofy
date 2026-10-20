import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { createPrototype } from "./fixture";
import { App } from "../src/App";
import type { Language, PlusActions } from "../src/model";

// The fixture's first commitment, selected in Week by default, has two steps.
const RELEASE = "Ship the small website refresh";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Plan in Week, at a commitment's Next steps; App's queue and re-reads run as on the page. */
async function week(
  actions: PlusActions = createPrototype(),
  language: Language = "en",
) {
  render(
    <App
      actions={actions}
      view="plan"
      language={language}
      onOpenTask={() => {}}
      onSettings={() => {}}
    />,
  );
  fireEvent.click(
    await screen.findByRole("tab", {
      name: language === "zh" ? "一周安排" : "Week",
    }),
  );
}
function tray(title = RELEASE) {
  return within(screen.getByRole("region", { name: `Next steps: ${title}` }));
}
function openAddStep(title = RELEASE) {
  fireEvent.click(
    tray(title).getByRole("button", { name: `Add steps to “${title}”` }),
  );
  return tray(title).getByRole<HTMLInputElement>("textbox", {
    name: "New step",
  });
}
function type(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
}
/** A write or read that waits until the test lets it go on. */
function gate() {
  let open = () => {};
  const passed = new Promise<void>((resolve) => (open = resolve));
  return { passed, open };
}
/** The waiting step cards: each title, and what its mark and its second line say. */
const pendingCards = () =>
  [...document.querySelectorAll(".planning-tray-step.is-pending")].map(
    (card) =>
      `${card.querySelector(".planning-step-title > span")?.textContent} (${card.querySelector(".plus-pending-mark")?.getAttribute("aria-label")}; ${card.querySelector(".planning-step-title > small")?.textContent})`,
  );
const statusLine = () =>
  document.querySelector(".planning-add-step-cell [role=status]")!;

it("opens in place of Todoist's Add task row, focused, at the same 32px row", async () => {
  await week();
  const button = tray().getByRole("button", {
    name: `Add steps to “${RELEASE}”`,
  });
  // The row's text, with its accent plus, is Next steps' last cell.
  expect(button.textContent).toBe("Add steps");
  expect(button.className).toBe("planning-add-step");
  expect(document.querySelector(".planning-tray-steps")!.lastElementChild).toBe(
    button.parentElement,
  );
  const input = openAddStep();
  expect(document.activeElement).toBe(input);
  expect(input.className).toBe("planning-add-step-input");
  expect(input.placeholder).toBe("Step name, Enter to add");
  expect(input.maxLength).toBe(500);
  expect(
    document.getElementById(input.getAttribute("aria-describedby")!)
      ?.textContent,
  ).toBe("Enter adds it, Escape closes");
  // The live region is there before any step, empty.
  expect(statusLine().textContent).toBe("");
});

it("adds a step at Enter, clears at once for the next, and shows it waiting until a read lists it", async () => {
  const actions = createPrototype();
  const write = gate();
  const read = gate();
  const create = actions.createSteps.bind(actions);
  const createSteps = vi
    .spyOn(actions, "createSteps")
    .mockImplementationOnce(async (...args) => {
      await write.passed;
      return create(...args);
    });
  const load = actions.load.bind(actions);
  await week(actions);
  vi.spyOn(actions, "load").mockImplementation(async (week) => {
    await read.passed;
    return load(week);
  });
  const input = openAddStep();
  type(input, "  Draft the release note  ");
  fireEvent.keyDown(input, { key: "Enter" });
  // Cleared and still focused at once; the title waits as a dimmed card before Add steps.
  expect(input.value).toBe("");
  expect(document.activeElement).toBe(input);
  expect(input.readOnly).toBe(false);
  expect(pendingCards()).toEqual([
    "Draft the release note (Updating…; Updating…)",
  ]);
  expect(
    document
      .querySelector(".planning-tray-step.is-pending")!
      .getAttribute("aria-busy"),
  ).toBe("true");
  // One confirm-first write, in App's queue.
  await waitFor(() => expect(createSteps).toHaveBeenCalledOnce());
  expect(createSteps.mock.calls[0]!.slice(0, 2)).toEqual([
    expect.objectContaining({ id: "release" }),
    [{ title: "Draft the release note", estimatedMinutes: 30 }],
  ]);
  // While it saves, Enter adds nothing more; typing goes on.
  await waitFor(() => expect(input.getAttribute("aria-disabled")).toBe("true"));
  type(input, "Check the links");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(createSteps).toHaveBeenCalledOnce();
  expect(input.value).toBe("Check the links");
  write.open();
  await waitFor(() =>
    expect(statusLine().textContent).toBe("Step added: Draft the release note"),
  );
  // Saved, but no read lists it yet: it still waits.
  expect(pendingCards()).toEqual([
    "Draft the release note (Updating…; Updating…)",
  ]);
  read.open();
  await waitFor(() => expect(pendingCards()).toEqual([]));
  expect(
    tray().getByRole("button", { name: /^Draft the release note/u }),
  ).toBeTruthy();
  expect(input.getAttribute("aria-disabled")).toBeNull();
  // The next step is a new request.
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(createSteps).toHaveBeenCalledTimes(2));
  expect(createSteps.mock.calls[1]![1]).toEqual([
    { title: "Check the links", estimatedMinutes: 30 },
  ]);
  expect(createSteps.mock.calls[1]![2]).not.toBe(createSteps.mock.calls[0]![2]);
});

it("ignores an input method's Enter, and closes at Esc or at Enter with nothing typed", async () => {
  const actions = createPrototype();
  const createSteps = vi.spyOn(actions, "createSteps");
  await week(actions);
  let input = openAddStep();
  type(input, "中文步骤");
  fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  expect(createSteps).not.toHaveBeenCalled();
  expect(input.value).toBe("中文步骤");
  // Esc drops the draft and goes back to the row's button.
  fireEvent.keyDown(input, { key: "Escape" });
  expect(tray().queryByRole("textbox")).toBeNull();
  const button = tray().getByRole("button", {
    name: `Add steps to “${RELEASE}”`,
  });
  expect(document.activeElement).toBe(button);
  input = openAddStep();
  expect(input.value).toBe("");
  type(input, "   ");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(tray().queryByRole("textbox")).toBeNull();
  expect(document.activeElement).toBe(
    tray().getByRole("button", { name: `Add steps to “${RELEASE}”` }),
  );
  expect(createSteps).not.toHaveBeenCalled();
});

it("adds each step with the time beside it: 30 min, or the last one chosen while it stays open", async () => {
  const actions = createPrototype();
  const createSteps = vi.spyOn(actions, "createSteps");
  await week(actions);
  let input = openAddStep();
  const time = () =>
    tray().getByRole<HTMLSelectElement>("combobox", { name: "Estimate" });
  expect(
    [...time().options].map((option) => [option.value, option.text]),
  ).toEqual([
    ["15", "15 min"],
    ["30", "30 min"],
    ["60", "60 min"],
    ["90", "90 min"],
  ]);
  expect(time().value).toBe("30");
  type(input, "Draft the release note");
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(createSteps).toHaveBeenCalledOnce());
  await waitFor(() => expect(input.getAttribute("aria-disabled")).toBeNull());
  // A time chosen before typing; focus moving to it keeps the cell open.
  fireEvent.blur(input, { relatedTarget: time() });
  fireEvent.change(time(), { target: { value: "90" } });
  expect(tray().getByRole("textbox", { name: "New step" })).toBe(input);
  type(input, "Check the links");
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(createSteps).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(input.getAttribute("aria-disabled")).toBeNull());
  type(input, "Ask for a review");
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(createSteps).toHaveBeenCalledTimes(3));
  expect(createSteps.mock.calls.map((call) => call[1])).toEqual([
    [{ title: "Draft the release note", estimatedMinutes: 30 }],
    [{ title: "Check the links", estimatedMinutes: 90 }],
    [{ title: "Ask for a review", estimatedMinutes: 90 }],
  ]);
  // Focus leaving the whole cell, from the time, closes it; opened again it starts at 30.
  await waitFor(() => expect(input.getAttribute("aria-disabled")).toBeNull());
  fireEvent.blur(input, { relatedTarget: time() });
  fireEvent.blur(time());
  expect(tray().queryByRole("textbox")).toBeNull();
  expect(tray().queryByRole("combobox", { name: "Estimate" })).toBeNull();
  input = openAddStep();
  expect(time().value).toBe("30");
  // Escape on the time closes the cell too, back to the Add steps row.
  fireEvent.keyDown(time(), { key: "Escape" });
  expect(document.activeElement).toBe(
    tray().getByRole("button", { name: `Add steps to “${RELEASE}”` }),
  );
});

it("asks under a new request when a failed step's time is changed", async () => {
  const actions = createPrototype();
  const createSteps = vi
    .spyOn(actions, "createSteps")
    .mockRejectedValueOnce(new Error("Synthetic steps unavailable"));
  await week(actions);
  const input = openAddStep();
  const time = tray().getByRole<HTMLSelectElement>("combobox", {
    name: "Estimate",
  });
  fireEvent.change(time, { target: { value: "60" } });
  type(input, "Book the room");
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByText(/Synthetic steps unavailable/u);
  // The title comes back with its time.
  expect(input.value).toBe("Book the room");
  expect(time.value).toBe("60");
  await waitFor(() => expect(input.getAttribute("aria-disabled")).toBeNull());
  fireEvent.change(time, { target: { value: "15" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(createSteps).toHaveBeenCalledTimes(2));
  expect(createSteps.mock.calls[1]![1]).toEqual([
    { title: "Book the room", estimatedMinutes: 15 },
  ]);
  expect(createSteps.mock.calls[1]![2]).not.toBe(createSteps.mock.calls[0]![2]);
});

it("closes when left empty, and keeps a draft it is left with, writing nothing", async () => {
  const actions = createPrototype();
  const createSteps = vi.spyOn(actions, "createSteps");
  await week(actions);
  let input = openAddStep();
  fireEvent.blur(input);
  expect(tray().queryByRole("textbox")).toBeNull();
  input = openAddStep();
  type(input, "Half a thought");
  fireEvent.blur(input);
  expect(tray().getByRole("textbox", { name: "New step" })).toBe(input);
  expect(input.value).toBe("Half a thought");
  expect(createSteps).not.toHaveBeenCalled();
});

it("gives a failed title back to an empty input under the same request, and keeps a new draft instead", async () => {
  const actions = createPrototype();
  const write = gate();
  const createSteps = vi
    .spyOn(actions, "createSteps")
    .mockRejectedValueOnce(new Error("Synthetic steps unavailable"))
    .mockImplementationOnce(async () => {
      await write.passed;
      throw new Error("Synthetic steps unavailable again");
    });
  await week(actions);
  const input = openAddStep();
  type(input, "Book the room");
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByText(/Synthetic steps unavailable/u);
  expect(pendingCards()).toEqual([]);
  expect(input.value).toBe("Book the room");
  expect(statusLine().textContent).toBe("");
  // Enter again retries the same request (Todofy's receipt).
  await waitFor(() => expect(input.getAttribute("aria-disabled")).toBeNull());
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(createSteps).toHaveBeenCalledTimes(2));
  expect(createSteps.mock.calls[1]![2]).toBe(createSteps.mock.calls[0]![2]);
  // A draft typed while it saves stays; the failed title is dropped.
  type(input, "Something else");
  write.open();
  await screen.findByText(/Synthetic steps unavailable again/u);
  expect(input.value).toBe("Something else");
  expect(pendingCards()).toEqual([]);
});

it("asks under a new request once a failed title is edited", async () => {
  const actions = createPrototype();
  const createSteps = vi
    .spyOn(actions, "createSteps")
    .mockRejectedValueOnce(new Error("Synthetic steps unavailable"));
  await week(actions);
  const input = openAddStep();
  type(input, "Book the room");
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByText(/Synthetic steps unavailable/u);
  await waitFor(() => expect(input.getAttribute("aria-disabled")).toBeNull());
  type(input, "Book the small room");
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(createSteps).toHaveBeenCalledTimes(2));
  expect(createSteps.mock.calls[1]![1]).toEqual([
    { title: "Book the small room", estimatedMinutes: 30 },
  ]);
  expect(createSteps.mock.calls[1]![2]).not.toBe(createSteps.mock.calls[0]![2]);
});

it("never writes a draft under another commitment: selecting one closes the input", async () => {
  const actions = createPrototype();
  const createSteps = vi.spyOn(actions, "createSteps");
  await week(actions);
  const input = openAddStep();
  type(input, "A step for the release");
  fireEvent.click(
    within(
      document.querySelector<HTMLElement>(".planning-commitment-grid")!,
    ).getByRole("button", { name: /^Prepare the next research check-in/u }),
  );
  const research = tray("Prepare the next research check-in");
  expect(research.queryByRole("textbox")).toBeNull();
  expect(input.isConnected).toBe(false);
  // Opened again, it starts empty: Enter there closes it and writes nothing.
  const again = openAddStep("Prepare the next research check-in");
  expect(again.value).toBe("");
  fireEvent.keyDown(again, { key: "Enter" });
  expect(createSteps).not.toHaveBeenCalled();
});

it("keeps Add steps under the hint when every child of a commitment has a stage of its own", async () => {
  const actions = createPrototype();
  const load = actions.load.bind(actions);
  vi.spyOn(actions, "load").mockImplementation(async (week) => {
    const data = await load(week);
    const notes = data.plan.tasks.find((task) => task.id === "notes")!;
    data.plan.tasks.push({
      ...notes,
      id: "notes-weekly",
      title: "A weekly action of its own",
      parentId: "notes",
      stage: "weekly",
    });
    return data;
  });
  await week(actions, "zh");
  fireEvent.click(
    within(
      document.querySelector<HTMLElement>(".planning-commitment-grid")!,
    ).getByRole("button", { name: /^Organize the experiment notes/u }),
  );
  const region = screen.getByRole("region", {
    name: "下一步: Organize the experiment notes",
  });
  const hint = within(region).getByText("先写下一步，剩下的可以以后再想。");
  const grid = region.querySelector(".planning-tray-steps")!;
  // The hint stays above the steps grid, which holds Add steps alone.
  expect(hint.nextElementSibling).toBe(grid);
  expect(grid.querySelectorAll(".planning-tray-step")).toHaveLength(0);
  expect(
    within(region).getByRole("button", {
      name: "为「Organize the experiment notes」添加步骤",
    }).textContent,
  ).toBe("添加步骤");
});
