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
import { createPrototype } from "./fixture";
import { App } from "../src/App";
import type { EstimateResult, Language, PlusActions } from "../src/model";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(cleanup);

/** The fixture as Tasks lists it: children are steps, the rest tasks. "copy" takes 30 minutes. */
function native(): PlusActions {
  const actions = createPrototype();
  const load = actions.load.bind(actions);
  actions.load = async (week) => {
    const data = await load(week);
    data.plan.tasks = data.plan.tasks.map((task) => ({
      ...task,
      kind: task.parentId ? "step" : "task",
    }));
    return data;
  };
  return actions;
}
/** Opens the panel of `taskId` from Focus, as a host's deep link does. */
async function open(
  actions: PlusActions,
  taskId = "copy",
  language: Language = "en",
) {
  render(
    <App
      actions={actions}
      view="focus"
      language={language}
      externalTaskId={taskId}
      onOpenTask={() => {}}
      onSettings={() => {}}
    />,
  );
  return screen.findByRole("dialog");
}
const preset = (dialog: HTMLElement, minutes: number) =>
  within(dialog).getByRole<HTMLButtonElement>("button", {
    name: `${minutes} min`,
  });
const pressed = (dialog: HTMLElement) =>
  within(dialog)
    .queryAllByRole("button", { pressed: true })
    .map((button) => button.textContent);

it("shows a step only its heading, the note line, its parents and the time choices", async () => {
  const dialog = await open(native());
  expect(screen.getByRole("dialog", { name: "Write the introduction" })).toBe(
    dialog,
  );
  const panel = within(dialog);
  expect(panel.getByRole("heading", { level: 2 }).textContent).toBe(
    "Write the introduction",
  );
  expect(dialog.querySelector(".plus-task-breadcrumb")?.textContent).toBe(
    "Ship the small website refresh",
  );
  expect(
    panel.getAllByRole("button").map((button) => button.textContent),
  ).toEqual(["", "Open task", "15 min", "30 min", "60 min", "90 min"]);
  expect(panel.getByRole("button", { name: "Close" })).toBeTruthy();
  const group = panel.getByRole("group", {
    name: "Estimate: Write the introduction",
  });
  expect(within(group).getAllByRole("button")).toHaveLength(4);
  expect(
    within(group).getByRole("spinbutton", { name: "Estimate" }),
  ).toBeTruthy();
  expect(pressed(dialog)).toEqual(["30 min"]);
  // Stage, area, options, subtasks, new steps, dates and dependencies are in Open task.
  expect(panel.queryAllByRole("combobox")).toEqual([]);
  expect(panel.queryAllByRole("checkbox")).toEqual([]);
  expect(dialog.querySelector('input[type="date"], textarea')).toBeNull();
  expect(panel.queryByText("Over 2 hours", { exact: false })).toBeNull();
});

it("shows a chosen preset at once and keeps it, and focus, when Tasks saves it", async () => {
  const actions = native();
  const load = vi.spyOn(actions, "load");
  const saveEstimate = actions.updateEstimate.bind(actions);
  let finish!: () => void;
  const update = vi.spyOn(actions, "updateEstimate").mockImplementation(
    (taskId, minutes) =>
      new Promise<EstimateResult>((resolve) => {
        finish = () => resolve(saveEstimate(taskId, minutes));
      }),
  );
  const dialog = await open(actions);
  await waitFor(() => expect(load).toHaveBeenCalledOnce());
  const sixty = preset(dialog, 60);
  sixty.focus();
  fireEvent.click(sixty);
  // Shown before Tasks answers; the heading waits and the presets stop answering.
  expect(pressed(dialog)).toEqual(["60 min"]);
  expect(
    within(screen.getByRole("heading", { level: 2 })).getByRole("img", {
      name: "Updating…",
    }),
  ).toBeTruthy();
  expect(sixty.getAttribute("aria-disabled")).toBe("true");
  expect(sixty.disabled).toBe(false);
  fireEvent.click(preset(dialog, 90));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update).toHaveBeenCalledWith("copy", 60);
  expect(document.activeElement).toBe(sixty);

  await act(async () => finish());
  await waitFor(() =>
    expect(within(dialog).getByRole("status").textContent).toBe(
      "Estimate saved: 60 min",
    ),
  );
  // The same button, still pressed and focused: no remount, no flash back, no re-read.
  expect(preset(dialog, 60)).toBe(sixty);
  expect(document.activeElement).toBe(sixty);
  expect(pressed(dialog)).toEqual(["60 min"]);
  expect(sixty.hasAttribute("aria-disabled")).toBe(false);
  expect(screen.queryByRole("img", { name: "Updating…" })).toBeNull();
  expect(load).toHaveBeenCalledOnce();
  // Choosing the saved value again writes nothing.
  fireEvent.click(sixty);
  expect(update).toHaveBeenCalledOnce();
});

it("returns to the saved preset when Tasks refuses the estimate", async () => {
  const actions = native();
  vi.spyOn(actions, "updateEstimate").mockRejectedValue(
    new Error("Synthetic refusal"),
  );
  const dialog = await open(actions);
  fireEvent.click(preset(dialog, 90));
  expect(pressed(dialog)).toEqual(["90 min"]);
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "Change not saved; restored. Synthetic refusal",
    ),
  );
  expect(pressed(dialog)).toEqual(["30 min"]);
});

it("saves typed whole minutes from 1 to 1440 and refuses 0 and 1441", async () => {
  const actions = native();
  const update = vi.spyOn(actions, "updateEstimate");
  const dialog = await open(actions);
  const field = within(dialog).getByRole<HTMLInputElement>("spinbutton", {
    name: "Estimate",
  });
  expect(field.value).toBe("");
  for (const refused of ["0", "1441", "2.5"]) {
    fireEvent.change(field, { target: { value: refused } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field.getAttribute("aria-invalid")).toBe("true");
  }
  // Leaving drops a value it cannot save.
  fireEvent.blur(field);
  expect(field.value).toBe("");
  expect(field.hasAttribute("aria-invalid")).toBe(false);
  expect(update).not.toHaveBeenCalled();

  fireEvent.change(field, { target: { value: "1440" } });
  fireEvent.keyDown(field, { key: "Enter" });
  await waitFor(() => expect(update).toHaveBeenLastCalledWith("copy", 1440));
  // A value no preset has stays in the field, and no preset is pressed.
  await waitFor(() => expect(field.hasAttribute("aria-disabled")).toBe(false));
  expect(field.value).toBe("1440");
  expect(pressed(dialog)).toEqual([]);

  fireEvent.change(field, { target: { value: "1" } });
  fireEvent.blur(field);
  await waitFor(() => expect(update).toHaveBeenLastCalledWith("copy", 1));
  await waitFor(() => expect(field.value).toBe("1"));
  // Escape gives back the saved value; nothing is written.
  fireEvent.change(field, { target: { value: "45" } });
  fireEvent.keyDown(field, { key: "Escape" });
  expect(field.value).toBe("1");
  fireEvent.blur(field);
  expect(update).toHaveBeenCalledTimes(2);
});

it("names the time choices in Chinese", async () => {
  const dialog = await open(native(), "copy", "zh");
  expect(
    within(dialog).getByRole("group", {
      name: "预计用时：Write the introduction",
    }),
  ).toBeTruthy();
  expect(
    within(dialog)
      .getAllByRole("button", { pressed: true })
      .map((button) => button.textContent),
  ).toEqual(["30 分钟"]);
});

it("still opens a task's full planning panel", async () => {
  const dialog = await open(native(), "release");
  expect(
    within(dialog).getByRole("region", { name: "Steps & timing" }),
  ).toBeTruthy();
  expect(
    within(dialog).getByRole("combobox", { name: "Planning" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("dialog", { name: "Ship the small website refresh" }),
  ).toBe(dialog);
});
