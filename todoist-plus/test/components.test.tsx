import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { PlanView } from "../src/PlanView";
import { createPrototype } from "../design/fixture";
import type { FlowDayPlan, PlusData } from "../src/model";
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
  const update = vi.spyOn(actions, "updateTask");
  const load = vi.spyOn(actions, "load");
  render(
    <App
      actions={actions}
      view="plan"
      language="en"
      onOpenTask={() => {}}
      onSettings={() => {}}
    />,
  );
  fireEvent.click(
    await screen.findByRole("button", {
      name: /^Clear out the old development branch,/,
    }),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Planning" }), {
    target: { value: "committed" },
  });
  fireEvent.click(
    screen
      .getAllByRole("button", { name: "Save" })
      .find((button) => !(button as HTMLButtonElement).disabled)!,
  );
  await waitFor(() =>
    expect(
      within(screen.getByRole("region", { name: "Committed" })).getByText(
        "Clear out the old development branch",
      ),
    ).toBeTruthy(),
  );
  expect(update).toHaveBeenCalledOnce();
  // Only the edited field is written; the unchanged area is not sent again.
  expect(update.mock.calls[0]?.[1]).toEqual({ stage: "committed" });
  expect(load).toHaveBeenCalledOnce();
});
it("shows a step's own start window in Start now while its parent occupies the commitment quota", async () => {
  const actions = createPrototype();
  const { plan, focus, days } = await actions.load();
  const child = plan.tasks.find((task) => task.id === "copy")!;
  child.deadline = "2026-10-14";
  child.leadDays = 3;
  child.mustStart = true;
  child.area = "unassigned";
  render(
    <PlanView
      plan={plan}
      days={days}
      currentDate={focus.date}
      flowTasks={focus.flowTasks}
      onWeekChange={vi.fn()}
      language="en"
      busy={false}
      actions={actions}
      run={vi.fn()}
      editTask={vi.fn()}
      completeReview={vi.fn()}
    />,
  );
  const start = within(screen.getByRole("region", { name: "Start now" }));
  expect(
    start.getByRole("button", {
      name: "Write the introduction, No priority, Deadline tomorrow, Wed, Oct 14",
    }),
  ).toBeTruthy();
  // Its area comes from its parent.
  expect(start.getByText("Work")).toBeTruthy();
  expect(screen.getByText(/3\/5 work/)).toBeTruthy();
});
it("stopping a session preserves the task and queue; checkbox completes it", async () => {
  const actions = createPrototype();
  const load = vi.spyOn(actions, "load");
  const props = {
    actions,
    language: "en" as const,
    onOpenTask: () => {},
    onSettings: () => {},
  };
  const mounted = render(<App {...props} view="focus" />);
  fireEvent.click(
    await screen.findByLabelText("Start: Write the introduction"),
  );
  await screen.findByLabelText("Stop session");
  expect(load).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByLabelText("Stop session"));
  await waitFor(() =>
    expect(screen.queryByLabelText("Stop session")).toBeNull(),
  );
  expect(screen.getByText("Write the introduction")).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(1);
  mounted.rerender(<App {...props} view="plan" />);
  await screen.findByRole("region", { name: "Committed" });
  mounted.rerender(<App {...props} view="focus" />);
  expect(screen.getByLabelText("Start: Write the introduction")).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(1);
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

it("keeps a confirmed refresh when older duplicate week reads finish late", async () => {
  const actions = createPrototype();
  const staleFuture = await actions.loadDays("2026-10-19");
  const requests: ((days: FlowDayPlan[]) => void)[] = [];
  actions.loadDays = vi.fn(
    () => new Promise<FlowDayPlan[]>((resolve) => requests.push(resolve)),
  );
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
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  fireEvent.click(screen.getByRole("button", { name: "Next week" }));
  fireEvent.click(screen.getByRole("button", { name: "Next week" }));
  expect(requests).toHaveLength(2);
  await actions.moveTaskToDay("copy", undefined, staleFuture[1]!);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  const scheduled =
    '.planning-calendar-day[data-date="2026-10-20"] .planning-calendar-step[data-task-id="copy"]';
  await waitFor(() => expect(document.querySelector(scheduled)).toBeTruthy());
  await act(async () => requests[1]!(structuredClone(staleFuture)));
  expect(document.querySelector(scheduled)).toBeTruthy();
  await act(async () => requests[0]!(structuredClone(staleFuture)));
  expect(document.querySelector(scheduled)).toBeTruthy();
  expect(
    (await actions.load("2026-10-19")).days.find(
      (day) => day.date === "2026-10-20",
    )?.taskIds,
  ).toContain("copy");
});

it("keeps the latest week after navigating away and back while an older full refresh is pending", async () => {
  const actions = createPrototype();
  const stale = await actions.load();
  const latest = structuredClone(stale.days);
  latest[2]!.taskIds.push("copy");
  const originalDays = actions.loadDays;
  actions.loadDays = vi.fn(async (week) =>
    week === "2026-10-12" ? structuredClone(latest) : originalDays(week),
  );
  const originalLoad = actions.load;
  let finishRefresh!: (value: PlusData) => void;
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
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  fireEvent.click(screen.getByRole("button", { name: "Next week" }));
  await waitFor(() =>
    expect(
      document.querySelector('.planning-calendar-day[data-date="2026-10-19"]'),
    ).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "This week" }));
  const scheduled =
    '.planning-calendar-day[data-date="2026-10-14"] .planning-calendar-step[data-task-id="copy"]';
  await waitFor(() => expect(document.querySelector(scheduled)).toBeTruthy());
  actions.load = vi.fn(
    () =>
      new Promise<PlusData>((resolve) => {
        finishRefresh = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(actions.load).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole("button", { name: "Next week" }));
  await waitFor(() =>
    expect(
      document.querySelector('.planning-calendar-day[data-date="2026-10-19"]'),
    ).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "This week" }));
  await waitFor(() => expect(document.querySelector(scheduled)).toBeTruthy());
  await act(async () => finishRefresh(structuredClone(stale)));
  expect(document.querySelector(scheduled)).toBeTruthy();
  actions.load = originalLoad;
});

it("persists and clears an existing step's estimate through the task editor", async () => {
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
    await screen.findByRole("button", {
      name: "Write the introduction",
    }),
  );
  const estimate = screen.getByLabelText(
    "Estimate: Write the introduction",
  ) as HTMLSelectElement;
  fireEvent.change(estimate, { target: { value: "45" } });
  await waitFor(() => expect(estimate.value).toBe("45"));
  expect(
    (await actions.load()).plan.tasks.find((task) => task.id === "copy")
      ?.estimatedMinutes,
  ).toBe(45);
  fireEvent.change(estimate, { target: { value: "0" } });
  await waitFor(() => expect(estimate.value).toBe("0"));
  expect(
    (await actions.load()).plan.tasks.find((task) => task.id === "copy")
      ?.estimatedMinutes,
  ).toBeUndefined();
});
