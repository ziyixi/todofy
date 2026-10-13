import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { PlanView } from "../src/PlanView";
import { createPrototype } from "../design/fixture";
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(cleanup);
it("commits a candidate in one action and moves it into the committed group", async () => {
  const actions = createPrototype();
  render(
    <App
      actions={actions}
      view="plan"
      language="en"
      onOpenTask={() => {}}
      onSettings={() => {}}
    />,
  );
  await screen.findByText("Clear out the old development branch");
  fireEvent.change(
    screen.getByLabelText("Planning: Clear out the old development branch"),
    { target: { value: "committed" } },
  );
  await waitFor(async () =>
    expect(
      (await actions.load()).plan.tasks.find((task) => task.id === "cleanup")
        ?.stage,
    ).toBe("committed"),
  );
  expect(screen.getByText("4 / 5")).toBeTruthy();
});
it("preserves a child deadline in attention when its parent occupies the commitment quota", async () => {
  const actions = createPrototype();
  const { plan } = await actions.load();
  const child = plan.tasks.find((task) => task.id === "copy")!;
  child.mustStart = true;
  child.area = "unassigned";
  render(
    <PlanView
      plan={plan}
      language="en"
      busy={false}
      actions={actions}
      run={vi.fn()}
      editTask={vi.fn()}
      addFocus={vi.fn()}
    />,
  );
  expect(screen.getByText("Write the introduction")).toBeTruthy();
  expect(screen.getByText("3 / 5")).toBeTruthy();
});
it("stopping a session preserves the task and queue; checkbox completes it", async () => {
  const actions = createPrototype();
  render(
    <App
      actions={actions}
      view="focus"
      language="en"
      onOpenTask={() => {}}
      onSettings={() => {}}
    />,
  );
  fireEvent.click(
    await screen.findByLabelText("Start: Write the introduction"),
  );
  await screen.findByLabelText("Stop session");
  fireEvent.click(screen.getByLabelText("Stop session"));
  await waitFor(() =>
    expect(screen.queryByLabelText("Stop session")).toBeNull(),
  );
  expect(screen.getByText("Write the introduction")).toBeTruthy();
  fireEvent.click(
    screen.getByLabelText("Complete task: Write the introduction"),
  );
  await waitFor(() =>
    expect(screen.queryByText("Write the introduction")).toBeNull(),
  );
  expect((await actions.load()).focus.completedTaskIds).toContain("copy");
});
it("retries uncertain completion with the same request identity and keeps failed task visible", async () => {
  const actions = createPrototype();
  const original = actions.completeTask;
  const complete = vi
    .fn(original)
    .mockRejectedValueOnce(new Error("Connection interrupted"));
  actions.completeTask = complete;
  render(
    <App
      actions={actions}
      view="focus"
      language="en"
      onOpenTask={() => {}}
      onSettings={() => {}}
    />,
  );
  fireEvent.click(
    await screen.findByLabelText("Complete task: Write the introduction"),
  );
  await screen.findByRole("alert");
  expect(screen.getByText("Write the introduction")).toBeTruthy();
  fireEvent.click(
    screen.getByLabelText("Complete task: Write the introduction"),
  );
  await waitFor(() =>
    expect(screen.queryByText("Write the introduction")).toBeNull(),
  );
  expect(complete.mock.calls[0]?.[1]).toBe(complete.mock.calls[1]?.[1]);
});
it("settles an active task using the timer’s original flow day after midnight", async () => {
  const actions = createPrototype();
  const original = actions.load;
  actions.load = async () => {
    const data = await original();
    data.focus.timer = {
      taskId: "copy",
      flowDate: "2026-10-12",
      status: "paused",
      elapsedSeconds: 30,
      startedAt: "2026-10-12T23:59:00Z",
      etag: "old-day",
    };
    return data;
  };
  const complete = vi.fn(actions.completeTask);
  actions.completeTask = complete;
  render(
    <App
      actions={actions}
      view="focus"
      language="en"
      onOpenTask={() => {}}
      onSettings={() => {}}
    />,
  );
  fireEvent.click(
    await screen.findByLabelText("Complete task: Write the introduction"),
  );
  await waitFor(() => expect(complete).toHaveBeenCalled());
  expect(complete.mock.calls[0]?.[2]).toBe("2026-10-12");
});
