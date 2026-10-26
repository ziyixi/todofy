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
  onOpenTask = vi.fn(),
) {
  render(
    <App
      actions={actions}
      view="focus"
      language={language}
      externalTaskId={taskId}
      onOpenTask={onOpenTask}
      onSettings={() => {}}
    />,
  );
  // A deep link opens the native dialog before its first task read supplies the editor and name.
  return screen.findByRole("dialog", { name: /\S/u });
}
const preset = (dialog: HTMLElement, minutes: number) =>
  within(dialog).getByRole<HTMLButtonElement>("button", {
    name: `${minutes} min`,
  });
const pressed = (dialog: HTMLElement) =>
  within(dialog)
    .queryAllByRole("button", { pressed: true })
    .map((button) => button.textContent);

it("shows a step's heading, parents, time choices and direct deletion", async () => {
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
  ).toEqual([
    "",
    "Open task",
    "15 min",
    "30 min",
    "60 min",
    "90 min",
    "Delete step",
  ]);
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

it.each(["step", "standalone", "quick"] as const)(
  "edits and reopens a %s estimate through the same Focus panel",
  async (execution) => {
    const actions = native();
    const load = actions.load.bind(actions);
    actions.load = async (week) => {
      const data = await load(week);
      data.plan.tasks = data.plan.tasks.map((task) =>
        task.id === "copy"
          ? {
              ...task,
              kind: execution === "step" ? "step" : "task",
              planningFlags:
                execution === "step"
                  ? []
                  : execution === "quick"
                    ? ["quick"]
                    : ["task"],
              due: "2026-10-13",
              dueDatetime: "2026-10-13T04:25:00Z",
              dueTimezone: "Asia/Tokyo",
            }
          : task,
      );
      return data;
    };
    const before = (await actions.load()).plan.tasks.find(
      (task) => task.id === "copy",
    )!;
    const update = vi.spyOn(actions, "updateEstimate");
    const mount = () =>
      render(
        <App
          actions={actions}
          view="focus"
          language="en"
          onOpenTask={vi.fn()}
          onSettings={vi.fn()}
        />,
      );
    const app = mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Write the introduction" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Write the introduction",
    });
    expect(within(dialog).queryAllByRole("combobox")).toEqual([]);
    expect(dialog.querySelector(".plus-task-breadcrumb")?.textContent).toBe(
      "Ship the small website refresh",
    );
    fireEvent.click(preset(dialog, 60));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(preset(dialog, 60).hasAttribute("aria-disabled")).toBe(false),
    );
    expect(update).toHaveBeenCalledWith(before, 60);
    const saved = (await actions.load()).plan.tasks.find(
      (task) => task.id === "copy",
    )!;
    expect(saved).toEqual({
      ...before,
      estimatedMinutes: 60,
      etag: expect.any(String),
    });
    app.unmount();
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Write the introduction" }),
    );
    const reopened = await screen.findByRole("dialog", {
      name: "Write the introduction",
    });
    expect(pressed(reopened)).toEqual(["60 min"]);
    expect(
      screen.getByRole("button", {
        name: "Complete task: Write the introduction",
      }),
    ).toBeTruthy();
  },
);

/** The step as Plan holds it, whose etag the estimate write goes under. */
const copy = expect.objectContaining({ id: "copy", etag: expect.any(String) });

it("deletes a Step from Plan after confirmation, without opening the full task editor", async () => {
  const actions = native();
  const load = vi.spyOn(actions, "load");
  const deleteTask = actions.deleteTask.bind(actions);
  let finish!: () => void;
  const remove = vi.spyOn(actions, "deleteTask").mockImplementation(
    (task, requestId) =>
      new Promise<void>((resolve) => {
        finish = () => resolve(deleteTask(task, requestId));
      }),
  );
  const onOpenTask = vi.fn();
  const dialog = await open(actions, "copy", "en", onOpenTask);
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete step" }));
  expect(remove).not.toHaveBeenCalled();
  expect(
    within(dialog).getByRole("group", { name: "Delete step" }).textContent,
  ).toContain("Delete “Write the introduction”?");
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(remove).toHaveBeenCalledWith(copy, expect.any(String)),
  );
  expect(
    within(dialog).getByRole<HTMLButtonElement>("button", { name: "Delete" })
      .disabled,
  ).toBe(true);
  expect(dialog.hasAttribute("open")).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  expect(remove).toHaveBeenCalledOnce();
  await act(async () => finish());
  await waitFor(() => expect(dialog.hasAttribute("open")).toBe(false));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect(onOpenTask).not.toHaveBeenCalled();
  const data = await actions.load();
  expect(data.plan.tasks.some((task) => task.id === "copy")).toBe(false);
  expect(data.days.every((day) => !day.taskIds.includes("copy"))).toBe(true);
});

it("keeps the Step and confirmation after failed deletion, reusing its identity on retry", async () => {
  const actions = native();
  const remove = vi
    .spyOn(actions, "deleteTask")
    .mockRejectedValueOnce(new Error("Synthetic delete refused"));
  const dialog = await open(actions);
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete step" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "Synthetic delete refused",
    ),
  );
  expect(dialog.hasAttribute("open")).toBe(true);
  expect(
    (await actions.load()).plan.tasks.some((task) => task.id === "copy"),
  ).toBe(true);
  await waitFor(() =>
    expect(
      within(dialog).getByRole<HTMLButtonElement>("button", { name: "Delete" })
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
  expect(remove.mock.calls[1]?.[1]).toBe(remove.mock.calls[0]?.[1]);
  await waitFor(() => expect(dialog.hasAttribute("open")).toBe(false));
});

it("lets Escape cancel deletion and returns keyboard focus to Delete step", async () => {
  const actions = native();
  const remove = vi.spyOn(actions, "deleteTask");
  const dialog = await open(actions);
  const trigger = within(dialog).getByRole("button", { name: "Delete step" });
  trigger.focus();
  fireEvent.click(trigger);
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: "Escape" });
  expect(
    within(dialog).queryByRole("group", { name: "Delete step" }),
  ).toBeNull();
  expect(document.activeElement).toBe(
    within(dialog).getByRole("button", { name: "Delete step" }),
  );
  expect(dialog.hasAttribute("open")).toBe(true);
  expect(remove).not.toHaveBeenCalled();
});

it("shows a chosen preset at once and keeps it, and focus, when Tasks saves it", async () => {
  const actions = native();
  const load = vi.spyOn(actions, "load");
  const saveEstimate = actions.updateEstimate.bind(actions);
  let finish!: () => void;
  const update = vi.spyOn(actions, "updateEstimate").mockImplementation(
    (task, minutes) =>
      new Promise<EstimateResult>((resolve) => {
        finish = () => resolve(saveEstimate(task, minutes));
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
  expect(update).toHaveBeenCalledWith(copy, 60);
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
  await waitFor(() => expect(update).toHaveBeenLastCalledWith(copy, 1440));
  // A value no preset has stays in the field, and no preset is pressed.
  await waitFor(() => expect(field.hasAttribute("aria-disabled")).toBe(false));
  expect(field.value).toBe("1440");
  expect(pressed(dialog)).toEqual([]);

  fireEvent.change(field, { target: { value: "1" } });
  fireEvent.blur(field);
  await waitFor(() => expect(update).toHaveBeenLastCalledWith(copy, 1));
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

it("gives new steps from a task's panel the same times, 30 min unless another is chosen", async () => {
  const actions = native();
  const createSteps = vi.spyOn(actions, "createSteps");
  const dialog = await open(actions, "release");
  const panel = within(dialog);
  const presets = panel
    .getByText("Estimate", { selector: ".plus-estimate-presets > span" })
    .closest<HTMLElement>(".plus-estimate-presets")!;
  expect(
    within(presets)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["15 min", "30 min", "60 min", "90 min"]);
  expect(pressed(presets)).toEqual(["30 min"]);
  const lines = panel.getByRole("textbox", { name: "Add steps" });
  const add = () => {
    fireEvent.click(
      panel
        .getAllByRole("button", { name: "Add steps" })
        .find((button) => button.classList.contains("plus-primary"))!,
    );
  };
  fireEvent.change(lines, { target: { value: "Draft the outline" } });
  add();
  await waitFor(() => expect(createSteps).toHaveBeenCalledOnce());
  await waitFor(() => expect((lines as HTMLTextAreaElement).value).toBe(""));
  fireEvent.click(within(presets).getByRole("button", { name: "90 min" }));
  fireEvent.change(lines, { target: { value: "Check the outline" } });
  add();
  await waitFor(() => expect(createSteps).toHaveBeenCalledTimes(2));
  expect(createSteps.mock.calls.map((call) => call[1])).toEqual([
    [{ title: "Draft the outline", estimatedMinutes: 30 }],
    [{ title: "Check the outline", estimatedMinutes: 90 }],
  ]);
});
