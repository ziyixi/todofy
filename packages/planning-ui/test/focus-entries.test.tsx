import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createPrototype } from "./fixture";
import { FocusView } from "../src/FocusView";
import { recordArea } from "../src/FocusEntries";
import { pendingEntry } from "../src/plan-updates";
import type {
  FocusEntry,
  FocusTaskInfo,
  PendingChange,
  RunOperation,
} from "../src/model";

afterEach(cleanup);

/** Today's Focus with two records on "copy": a 25-minute session at 16:40 and 15 minutes added. */
async function setup(unlisted?: FocusTaskInfo) {
  const actions = createPrototype();
  const { plan, focus } = await actions.load();
  plan.timezone = "UTC";
  const entries: FocusEntry[] = [
    {
      id: "session",
      taskId: "copy",
      date: focus.date,
      seconds: 25 * 60,
      startedAt: "2026-10-13T16:40:00Z",
      source: "timer",
      area: "work",
      etag: "1",
    },
    {
      id: "added",
      taskId: "copy",
      date: focus.date,
      seconds: 15 * 60,
      source: "manual",
      area: "work",
      etag: "1",
    },
  ];
  focus.entries = entries;
  if (unlisted) {
    focus.taskIds.push("unlisted");
    focus.tasks["unlisted"] = unlisted;
  }
  // As the App runs a write: in order, with the change it waits on.
  const changes: PendingChange[] = [];
  const run: RunOperation = vi.fn(async (operation, change) => {
    if (change) changes.push(change);
    await operation();
    return true;
  });
  const writes = {
    add: vi.spyOn(actions, "addEntry"),
    update: vi.spyOn(actions, "updateEntry"),
    remove: vi.spyOn(actions, "deleteEntry"),
  };
  render(
    <FocusView
      plan={plan}
      focus={focus}
      language="en"
      busy={false}
      editTask={vi.fn()}
      complete={vi.fn()}
      onOpenPlan={vi.fn()}
      onTimer={vi.fn()}
      actions={actions}
      run={run}
      onOpenTask={vi.fn()}
    />,
  );
  return { focus, entries, changes, writes };
}
function open(name: string) {
  fireEvent.click(screen.getByRole("button", { name }));
  return screen.getByRole("dialog");
}

it("changes, deletes and adds a step's records through the write queue, each row waiting on its own key", async () => {
  const { focus, entries, changes, writes } = await setup();
  const records = open("40m logged: Write the introduction");
  expect(records.getAttribute("aria-labelledby")).toBeTruthy();
  expect(within(records).getByRole("heading").textContent).toBe(
    "Time records · Write the introduction",
  );
  // Focus moves into the popover, which never starts a card's drag.
  expect(document.activeElement).toBe(records);
  expect(records.hasAttribute("data-no-drag")).toBe(true);
  expect(within(records).getByText("Total 40m")).toBeTruthy();
  const session = within(records).getByRole("spinbutton", {
    name: "Minutes, 16:40",
  });
  expect((session as HTMLInputElement).value).toBe("25");
  expect(
    (
      within(records).getByRole("spinbutton", {
        name: "Minutes, added",
      }) as HTMLInputElement
    ).value,
  ).toBe("15");
  fireEvent.change(session, { target: { value: "40" } });
  await act(async () => {
    fireEvent.keyDown(session, { key: "Enter" });
  });
  expect(writes.update).toHaveBeenCalledExactlyOnceWith(entries[0], 40 * 60);
  expect(changes.at(-1)).toEqual({ pending: [pendingEntry("session")] });
  expect(within(records).getByRole("status").textContent).toBe("Saved");
  await act(async () => {
    fireEvent.click(
      within(records).getAllByRole("button", { name: "Delete record" })[1]!,
    );
  });
  expect(writes.remove).toHaveBeenCalledExactlyOnceWith(entries[1]);
  expect(changes.at(-1)).toEqual({ pending: [pendingEntry("added")] });
  expect(within(records).getByRole("status").textContent).toBe("Deleted");
  // Focus stayed in the popover while the row waited to leave.
  expect(records.contains(document.activeElement)).toBe(true);
  fireEvent.click(within(records).getByRole("button", { name: "Add time" }));
  const minutes = within(records).getByRole("spinbutton", { name: "Add time" });
  expect((minutes as HTMLInputElement).value).toBe("15");
  await act(async () => {
    fireEvent.keyDown(minutes, { key: "Enter" });
  });
  expect(writes.add).toHaveBeenCalledExactlyOnceWith({
    taskId: "copy",
    date: focus.date,
    seconds: 15 * 60,
    area: "work",
  });
  expect(changes.at(-1)).toEqual({
    pending: [pendingEntry(`new:copy:${focus.date}`)],
  });
  // The row closes, and focus goes back to "Add time".
  expect(
    within(records).queryByRole("spinbutton", { name: "Add time" }),
  ).toBeNull();
  expect(document.activeElement).toBe(
    within(records).getByRole("button", { name: "Add time" }),
  );
});

it("refuses zero minutes; Escape puts the saved value back, a second Escape closes, and so does Tab out", async () => {
  const { writes } = await setup();
  const trigger = screen.getByRole("button", {
    name: "40m logged: Write the introduction",
  });
  let records = open("40m logged: Write the introduction");
  const session = within(records).getByRole("spinbutton", {
    name: "Minutes, 16:40",
  }) as HTMLInputElement;
  fireEvent.change(session, { target: { value: "0" } });
  fireEvent.keyDown(session, { key: "Enter" });
  expect(writes.update).not.toHaveBeenCalled();
  expect(session.getAttribute("aria-invalid")).toBe("true");
  fireEvent.keyDown(session, { key: "Escape" });
  expect(session.value).toBe("25");
  expect(screen.getByRole("dialog")).toBe(records);
  fireEvent.keyDown(session, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  // Focus moving within it keeps it open.
  records = open("40m logged: Write the introduction");
  const added = within(records).getByRole("spinbutton", {
    name: "Minutes, added",
  });
  fireEvent.focusOut(records, { relatedTarget: added });
  expect(screen.getByRole("dialog")).toBe(records);
  // Tab out of it closes it, leaving focus where Tab took it.
  const outside = screen.getByRole("button", { name: "Adjust plan" });
  fireEvent.focusOut(added, { relatedTarget: outside });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(writes.update).not.toHaveBeenCalled();
});

it("adds time to a step Plan does not list in its parent's area", async () => {
  const { focus, writes } = await setup({
    title: "Synthetic unlisted step",
    parentId: "desk",
    parentTitle: "Make the home desk comfortable",
    completed: false,
  });
  const records = open("Log time: Synthetic unlisted step");
  expect(within(records).getByText("No time recorded.")).toBeTruthy();
  fireEvent.click(within(records).getByRole("button", { name: "Add time" }));
  await act(async () => {
    fireEvent.click(within(records).getByRole("button", { name: "Add" }));
  });
  expect(writes.add).toHaveBeenCalledExactlyOnceWith({
    taskId: "unlisted",
    date: focus.date,
    seconds: 15 * 60,
    area: "personal",
  });
});

it("counts added time in the task's area, else its latest record's, else its listed parent's, else none", async () => {
  const { plan } = await createPrototype().load();
  const record = (area: FocusEntry["area"], id: string): FocusEntry => ({
    id,
    taskId: "done",
    date: "2026-10-13",
    seconds: 60,
    source: "timer",
    area,
    etag: "1",
  });
  const info = (parentId: string): FocusTaskInfo => ({
    title: "Synthetic completed step",
    parentId,
    parentTitle: "",
    completed: true,
  });
  // Listed: its own area, inherited from its outcome.
  expect(recordArea("measure", plan, undefined, [])).toBe("personal");
  // Completed, so no longer listed: the area its latest record kept.
  expect(
    recordArea("done", plan, info("release"), [
      record("work", "1"),
      record("personal", "2"),
    ]),
  ).toBe("personal");
  // No record: its parent's, when Plan lists the parent.
  expect(recordArea("done", plan, info("desk"), [])).toBe("personal");
  expect(recordArea("done", plan, info("elsewhere"), [])).toBe("unassigned");
  expect(recordArea("done", plan, undefined, [])).toBe("unassigned");
});
