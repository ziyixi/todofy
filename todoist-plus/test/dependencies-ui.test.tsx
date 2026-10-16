import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { createPrototype } from "../design/fixture";
import type { PlusActions } from "../src/model";

// The fixture's tasks are synthetic; today is Tuesday 2026-10-13.
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
});

/** Plan with the editor of `taskId` open, as a card click or a native link opens it. */
async function details(actions: PlusActions, taskId: string) {
  render(
    <App
      actions={actions}
      view="plan"
      language="en"
      externalTaskId={taskId}
      onOpenTask={vi.fn()}
      onSettings={vi.fn()}
    />,
  );
  const editor = await screen.findByRole("region", { name: "Steps & timing" });
  return within(editor);
}
const section = (editor: ReturnType<typeof within>) =>
  editor
    .getByRole("heading", { name: "Depends on" })
    .closest(".plus-dependencies") as HTMLElement;

it("adds a dependency from the search field with the keyboard, greys a cycle and keeps Escape to itself", async () => {
  const actions = createPrototype();
  // The notes already wait for the release, so the release cannot wait for them.
  await actions.setDependency("notes", "release", true);
  const set = vi.spyOn(actions, "setDependency");
  const editor = await details(actions, "release");
  const own = within(section(editor));
  expect(
    own.getByText("“Organize the experiment notes” is waiting for this"),
  ).toBeTruthy();
  fireEvent.click(own.getByRole("button", { name: "Add a dependency" }));
  const search = own.getByRole("combobox", { name: "Search tasks or parents" });
  expect(document.activeElement).toBe(search);
  // Nothing is listed before typing.
  expect(own.queryByRole("listbox")).toBeNull();
  fireEvent.change(search, { target: { value: "notes" } });
  const cycle = own.getByRole("option", {
    name: /Organize the experiment notes/u,
  });
  expect(cycle.getAttribute("aria-disabled")).toBe("true");
  expect(within(cycle).getByText("Would wait on each other")).toBeTruthy();
  fireEvent.keyDown(search, { key: "Enter" });
  fireEvent.click(cycle);
  expect(set).not.toHaveBeenCalled();
  // Escape closes only the picker: neither Plan's dialog nor Todoist's modal hears it.
  const outside = vi.fn();
  document.addEventListener("keydown", outside);
  fireEvent.keyDown(search, { key: "Escape" });
  document.removeEventListener("keydown", outside);
  expect(outside).not.toHaveBeenCalled();
  expect(own.queryByRole("combobox")).toBeNull();
  expect(document.querySelector("dialog")?.hasAttribute("open")).toBe(true);
  await waitFor(() =>
    expect(document.activeElement).toBe(
      own.getByRole("button", { name: "Add a dependency" }),
    ),
  );
  // A parent's title finds its steps; the arrows move, Enter adds.
  fireEvent.click(own.getByRole("button", { name: "Add a dependency" }));
  const again = own.getByRole("combobox");
  fireEvent.change(again, { target: { value: "check-in" } });
  expect(
    own.getAllByRole("option").map((option) => option.textContent),
  ).toEqual([
    "Prepare the next research check-in",
    "Outline three questions for the check-inPrepare the next research check-in",
  ]);
  fireEvent.keyDown(again, { key: "ArrowDown" });
  expect(own.getAllByRole("option")[1]!.getAttribute("aria-selected")).toBe(
    "true",
  );
  fireEvent.keyDown(again, { key: "ArrowUp" });
  fireEvent.keyDown(again, { key: "Enter" });
  await waitFor(() =>
    expect(set).toHaveBeenCalledWith("release", "research", true),
  );
  await within(section(editor)).findByRole("button", {
    name: "Prepare the next research check-in",
  });
  expect(editor.getByRole("status").textContent).toBe(
    "Added dependency: Prepare the next research check-in",
  );
  // The row's one action, named for its task.
  fireEvent.click(
    within(section(editor)).getByRole("button", {
      name: "Remove dependency: Prepare the next research check-in",
    }),
  );
  await waitFor(() =>
    expect(editor.getByRole("status").textContent).toBe(
      "Removed dependency: Prepare the next research check-in",
    ),
  );
  expect(set).toHaveBeenLastCalledWith("release", "research", false);
  expect(within(section(editor)).queryByRole("listitem")).toBeNull();
});

it("says when what it waits for is done, and stops at five", async () => {
  const actions = createPrototype();
  await actions.setDependency("release", "tools", true);
  await actions.setDependency("release", "cleanup", true);
  await actions.completeTask(
    (await actions.load()).plan.tasks.find((task) => task.id === "tools")!,
    "r1",
    "",
  );
  const editor = await details(actions, "release");
  const own = within(section(editor));
  expect(own.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "Clear out the old development branch",
  ]);
  expect(own.getByText("1 more is done")).toBeTruthy();
  cleanup();
  await actions.completeTask(
    (await actions.load()).plan.tasks.find((task) => task.id === "cleanup")!,
    "r2",
    "",
  );
  const ready = within(section(await details(actions, "release")));
  expect(
    ready.getByText("Everything it waits for is done — ready to start"),
  ).toBeTruthy();
  cleanup();
  for (const id of ["copy", "layout", "notes", "reading", "walk"])
    await actions.setDependency("release", id, true);
  const full = within(section(await details(actions, "release")));
  const add = full.getByRole("button", {
    name: "Add a dependency",
  }) as HTMLButtonElement;
  expect(add.disabled).toBe(true);
  expect(add.title).toBe("Up to 5");
});

it("settles what a complete read misses once per visit and tells a deletion once in Review", async () => {
  const actions = createPrototype();
  await actions.setDependency("notes", "venue", true);
  // The venue's task is gone from the active list.
  await actions.completeTask(
    (await actions.load()).plan.tasks.find((task) => task.id === "venue")!,
    "r1",
    "",
  );
  const resolve = vi
    .spyOn(actions, "resolveDependencies")
    .mockResolvedValue({ dependencies: [], dropped: ["notes"] });
  const load = vi.spyOn(actions, "load");
  render(
    <App
      actions={actions}
      view="plan"
      language="zh"
      onOpenTask={vi.fn()}
      onSettings={vi.fn()}
    />,
  );
  const notice = await screen.findByText(
    "「Organize the experiment notes」等的任务已被删除，不再等待。",
  );
  expect(notice.closest('[role="status"]')).toBeTruthy();
  expect(resolve).toHaveBeenCalledExactlyOnceWith(["venue"]);
  // A later complete read still misses the venue, but it was asked about in this visit.
  fireEvent.click(screen.getByRole("button", { name: "刷新" }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(resolve).toHaveBeenCalledOnce();
});
