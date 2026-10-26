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
import { createPrototype } from "./fixture";
import type { FocusRange, PlusData } from "../src/model";
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
it("shows a step's own start window in Parked while its parent occupies the commitment quota", async () => {
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
      focusTasks={focus.tasks}
      onWeekChange={vi.fn()}
      language="en"
      busy={false}
      actions={actions}
      run={vi.fn()}
      editTask={vi.fn()}
      completeTask={vi.fn()}
      completeReview={vi.fn()}
    />,
  );
  const parked = within(screen.getByRole("region", { name: "Parked" }));
  // Its area, in its name and edge colour, comes from its parent.
  const card = parked.getByRole("button", {
    name: "Write the introduction, Work, No priority, Deadline tomorrow, Wed, Oct 14",
  });
  expect(card.style.getPropertyValue("--area-color")).toBe(
    "var(--plus-area-work)",
  );
  expect(screen.getByText(/3\/5 work/)).toBeTruthy();
});
// A guard against a future cap: Week's Committed has none, and wraps every commitment into rows.
it("shows every commitment in Week, eleven of them included, each with its complete button", async () => {
  const actions = createPrototype();
  const { plan, focus, days } = await actions.load();
  const template = plan.tasks.find((task) => task.id === "notes")!;
  const committed = plan.tasks.filter(
    (task) => task.stage === "committed",
  ).length;
  for (let index = committed + 1; index <= 11; index++)
    plan.tasks.push({
      ...template,
      id: `commitment-${index}`,
      title: `Synthetic commitment ${index}`,
      area: index % 2 ? "work" : "personal",
    });
  render(
    <PlanView
      plan={plan}
      days={days}
      currentDate={focus.date}
      focusTasks={focus.tasks}
      onWeekChange={vi.fn()}
      language="en"
      busy={false}
      actions={actions}
      run={vi.fn()}
      editTask={vi.fn()}
      completeTask={vi.fn()}
      completeReview={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  const grid = document.querySelector(".planning-commitment-grid")!;
  expect(grid.querySelectorAll(".planning-commitment")).toHaveLength(11);
  expect(
    within(grid as HTMLElement).getAllByRole("button", {
      name: /^Complete task: /u,
    }),
  ).toHaveLength(11);
  expect(screen.getByText("11 outcomes")).toBeTruthy();
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
it("completes on Focus's day and leaves a timer's own day to Tasks after midnight", async () => {
  const actions = createPrototype();
  const original = actions.load;
  actions.load = async () => {
    const data = await original();
    data.focus.timer = {
      taskId: "copy",
      day: "2026-10-12",
      area: "work",
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
  // Tasks settles the session on its own day in the same write.
  expect(complete.mock.calls[0]?.[2]).toBe("2026-10-13");
});

it("keeps a confirmed refresh when older duplicate week reads finish late", async () => {
  const actions = createPrototype();
  const staleFuture = await actions.loadDays("2026-10-19");
  const requests: ((range: FocusRange) => void)[] = [];
  actions.loadDays = vi.fn(
    () => new Promise<FocusRange>((resolve) => requests.push(resolve)),
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
  await actions.moveTaskToDay("copy", undefined, staleFuture.days[1]!);
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
  latest.find((day) => day.date === "2026-10-14")!.taskIds.push("copy");
  // A step done that day, which only the week's own read names.
  latest
    .find((day) => day.date === "2026-10-14")!
    .completedTaskIds.push("past-step");
  const named = {
    "past-step": {
      title: "Synthetic step done this week",
      parentId: "",
      parentTitle: "",
      completed: true,
    },
  };
  const originalDays = actions.loadDays;
  actions.loadDays = vi.fn(async (week) =>
    week === "2026-10-11"
      ? { days: structuredClone(latest), tasks: named, today: "2026-10-13" }
      : originalDays(week),
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
  // The older read named another week's tasks; the week shown keeps the names its read gave.
  expect(
    screen.getByRole("button", {
      name: "Completed: Synthetic step done this week",
    }),
  ).toBeTruthy();
  actions.load = originalLoad;
});

it("keeps a ticked calendar step in its day, done and out of the total, and leaves Focus as it was", async () => {
  const actions = createPrototype();
  const props = {
    actions,
    language: "en" as const,
    onOpenTask: () => {},
    onSettings: () => {},
  };
  const { rerender } = render(<App {...props} view="plan" />);
  await screen.findByRole("region", { name: "Committed" });
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  const column = () =>
    document.querySelector<HTMLElement>(
      '.planning-calendar-day[data-date="2026-10-13"]',
    )!;
  const total = () =>
    column().querySelector(".planning-day-heading small")?.textContent;
  // Write the introduction 30m, Outline three questions 1h, Download the receipt 15m.
  expect(total()).toBe("1h 45m");
  fireEvent.click(
    within(column()).getByRole("button", {
      name: "Complete task: Write the introduction",
    }),
  );
  // After the re-read it stays, done, after the open steps.
  await waitFor(() =>
    expect(
      within(column()).getByRole("button", {
        name: "Completed: Write the introduction",
      }),
    ).toBeTruthy(),
  );
  expect(
    [...column().querySelectorAll<HTMLElement>(".planning-calendar-step")].map(
      (card) => [card.dataset.taskId, card.classList.contains("is-done")],
    ),
  ).toEqual([
    ["outline", false],
    ["receipt", false],
    ["copy", true],
  ]);
  expect(total()).toBe("1h 15m");
  // Focus is as it was: the queue has the open steps; the done one shows only under Completed.
  rerender(<App {...props} view="focus" />);
  await screen.findByRole("button", {
    name: "Complete task: Outline three questions for the check-in",
  });
  expect(screen.queryByText("Write the introduction")).toBeNull();
  fireEvent.click(screen.getByRole("checkbox", { name: "Completed" }));
  expect(
    within(document.querySelector<HTMLElement>(".plus-focus-done")!).getByText(
      "Write the introduction",
    ),
  ).toBeTruthy();
});

it("names another week's done steps from that week's read", async () => {
  const actions = createPrototype();
  const originalDays = actions.loadDays;
  actions.loadDays = vi.fn(async (week) => {
    const range = await originalDays(week);
    if (week !== "2026-10-18") return range;
    range.days[0]!.completedTaskIds = ["done-next-week"];
    range.tasks["done-next-week"] = {
      title: "Synthetic step done next Monday",
      parentId: "release",
      parentTitle: "Ship the small website refresh",
      estimatedMinutes: 20,
      completed: true,
    };
    return range;
  });
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
  const done = await screen.findByRole("button", {
    name: "Completed: Synthetic step done next Monday",
  });
  expect(
    done.closest('[data-task-id="done-next-week"]')?.textContent,
  ).toContain("Ship the small website refresh");
});

it("persists and clears an existing step's estimate through the task editor, each write under the etag the last one gave", async () => {
  const actions = createPrototype();
  const update = vi.spyOn(actions, "updateEstimate");
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
  // An estimate is a write of the task, which answers its new etag: the next write goes under it.
  const first = await update.mock.results[0]!.value;
  expect(update.mock.calls[1]![0].etag).toBe(first.etag);
});
it("selects a Week commitment on a click, keeps it selected, and opens its panel on a double-click", async () => {
  const actions = createPrototype();
  const { plan, focus, days } = await actions.load();
  const editTask = vi.fn();
  render(
    <PlanView
      plan={plan}
      days={days}
      currentDate={focus.date}
      focusTasks={focus.tasks}
      onWeekChange={vi.fn()}
      language="en"
      busy={false}
      actions={actions}
      run={vi.fn()}
      editTask={editTask}
      completeTask={vi.fn()}
      completeReview={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: /^Week$/u }));
  const card = within(
    document.querySelector<HTMLElement>(".planning-commitment-grid")!,
  ).getByRole("button", { name: /^Prepare the next research check-in,/u });
  const tray = () =>
    screen.getByRole("region", {
      name: "Next steps: Prepare the next research check-in",
    });
  // Two single clicks select it; the second does not take the selection away.
  fireEvent.click(card);
  fireEvent.click(card);
  expect(card.classList.contains("is-selected")).toBe(true);
  expect(tray()).toBeTruthy();
  expect(editTask).not.toHaveBeenCalled();
  fireEvent.doubleClick(card);
  expect(editTask).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: "research" }),
  );
  expect(card.classList.contains("is-selected")).toBe(true);
  // The tray's button opens the selected commitment, and its name says which.
  fireEvent.click(
    within(tray()).getByRole("button", {
      name: "Steps & timing: Prepare the next research check-in",
    }),
  );
  expect(editTask).toHaveBeenCalledTimes(2);
});

it("keeps the panel open, and its controls still, through the rest of the double-click that opened it", async () => {
  const actions = createPrototype();
  const write = vi.spyOn(actions, "updateTask");
  render(
    <App
      actions={actions}
      view="plan"
      language="en"
      onOpenTask={() => {}}
      onSettings={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("tab", { name: /^Week$/u }));
  const title = within(
    screen.getByRole("region", {
      name: "Next steps: Ship the small website refresh",
    }),
  ).getByRole("button", { name: /^Write the introduction/u });
  // The first click opens the panel, which the second press and click then land on.
  fireEvent.click(title, { detail: 1 });
  const dialog = screen.getByRole("dialog", {
    name: "Write the introduction",
  });
  const planning = within(dialog).getByRole("combobox", { name: "Planning" });
  expect(fireEvent.mouseDown(planning, { detail: 2 })).toBe(false);
  expect(fireEvent.mouseDown(dialog, { detail: 2 })).toBe(false);
  fireEvent.click(dialog, { detail: 2 });
  const routine = within(dialog).getByRole<HTMLInputElement>("switch", {
    name: "Routine",
  });
  fireEvent.click(routine, { detail: 2 });
  expect(dialog.hasAttribute("open")).toBe(true);
  expect(routine.checked).toBe(false);
  expect(write).not.toHaveBeenCalled();
  // A single press is left alone, and a click on the backdrop still closes it.
  expect(fireEvent.mouseDown(planning, { detail: 1 })).toBe(true);
  fireEvent.click(dialog, { detail: 1 });
  expect(dialog.hasAttribute("open")).toBe(false);
});
