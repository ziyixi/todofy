import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { fakeActions } from "./transport";
import { PlanView, type PlanViewProps } from "../src/PlanView";
import {
  isoWeek,
  oldestUntouched,
  unscheduledCommitments,
  untouchedDays,
  WAITING_LABELS,
} from "../src/weekly-review";
import {
  DEFAULT_PLAN_VIEW,
  mergePlanView,
  type PlanViewPatch,
  type PlanViewState,
} from "../src/plan-view-state";
import { createPrototype } from "./fixture";
import type { PlanningTask, PlusActions } from "../src/model";

// The fixture's week is 2026-10-12 (ISO 2026-W42); "now" is its Tuesday.
const NOW = Date.parse("2026-10-13T12:00:00Z");
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function props(
  actions: PlusActions = createPrototype(),
): Promise<PlanViewProps> {
  const { plan, focus, days } = await actions.load();
  return {
    plan,
    days,
    flowTasks: focus.flowTasks,
    currentDate: focus.date,
    language: "en",
    busy: false,
    actions,
    // Runs the write at once, as the App's queue does when nothing is ahead of it.
    run: vi.fn(async (operation: () => Promise<unknown>) => {
      await operation();
      return true;
    }),
    editTask: vi.fn(),
    onWeekChange: vi.fn(),
    completeTask: vi.fn(),
    completeReview: vi.fn(async () => true),
  };
}
function openReview() {
  fireEvent.click(screen.getByRole("button", { name: "Weekly review" }));
  return within(screen.getByRole("region", { name: "Weekly review" }));
}
function renderApp(
  actions: PlusActions,
  onPlanView?: (patch: PlanViewPatch) => void,
) {
  render(
    <App
      actions={actions}
      view="plan"
      language="en"
      onOpenTask={() => {}}
      onSettings={() => {}}
      onPlanView={onPlanView}
    />,
  );
}
function line(review: ReturnType<typeof openReview>, name: string) {
  return review.getByRole("checkbox", { name: `Reviewed: ${name}` })
    .parentElement!;
}

it("names ISO weeks by their Thursday, across year ends", () => {
  expect(isoWeek("2026-10-12")).toBe("2026-W42");
  expect(isoWeek("2026-10-18")).toBe("2026-W42");
  expect(isoWeek("2026-12-28")).toBe("2026-W53");
  expect(isoWeek("2027-01-03")).toBe("2026-W53");
  expect(isoWeek("2027-01-04")).toBe("2027-W01");
  expect(isoWeek("2025-12-29")).toBe("2026-W01");
});

it("derives the review lines from loaded data only", async () => {
  const { plan, days } = await props();
  const waiting = oldestUntouched(plan.tasks, WAITING_LABELS);
  expect(waiting.map((task) => task.id)).toEqual(["venue", "access"]);
  expect(waiting.map((task) => untouchedDays(task, NOW))).toEqual([11, 3]);
  // Unknown ages sort last and say nothing.
  const unknown = { ...waiting[0]!, id: "unknown", updatedAt: undefined };
  expect(
    oldestUntouched([unknown, ...waiting], WAITING_LABELS).map(
      (task) => task.id,
    ),
  ).toEqual(["venue", "access", "unknown"]);
  expect(untouchedDays(unknown)).toBeUndefined();
  // Notes has no step and Desk's step is not in any of the seven days.
  expect(unscheduledCommitments(plan, days).map((task) => task.id)).toEqual([
    "notes",
    "desk",
  ]);
});

it("draws waiting tasks as cards in the lane left of the stage lanes, oldest untouched first, and writes nothing", async () => {
  const data = await props();
  render(<PlanView {...data} />);
  const lanes = [...document.querySelectorAll(".review-lane")].map((lane) =>
    lane.getAttribute("aria-label"),
  );
  expect(lanes.slice(lanes.indexOf("Waiting"))).toEqual([
    "Waiting",
    "Parked",
    "Quarter",
    "Month",
    "Week",
    "Committed",
  ]);
  const waiting = within(screen.getByRole("region", { name: "Waiting" }));
  expect(
    waiting
      .getAllByRole("button", { name: /, No priority/u })
      .map((card) => card.getAttribute("aria-label")),
  ).toEqual([
    "Hear back about the venue quote, Work, No priority, No change in 11 days",
    "Lab access approval, Work, No priority, No change in 3 days",
  ]);
  // A card opens the task's details; nothing was written: no label is removed and nobody is
  // contacted.
  fireEvent.click(
    waiting.getByRole("button", { name: /^Lab access approval,/u }),
  );
  expect(data.editTask).toHaveBeenCalledWith(
    expect.objectContaining({ id: "access" }),
  );
  expect(data.run).not.toHaveBeenCalled();
});

it("keeps unclarified mail as the first line only, never as cards on the board", async () => {
  const data = await props();
  render(<PlanView {...data} />);
  for (const title of [
    "Fwd: Conference registration opens",
    "Re: Shared notes for Friday",
  ])
    expect(
      screen.queryByRole("button", { name: new RegExp(`^${title}`, "u") }),
    ).toBeNull();
  const review = openReview();
  expect(line(review, "Mail to clarify").textContent).toContain("2");
});

it("lists deadlines without a start-ahead choice in one line, with the editor's lead control", async () => {
  const actions = createPrototype();
  // Todofy's confirmed task: the lead chosen, so no longer missing one.
  const lead = vi
    .spyOn(actions, "updateLead")
    .mockImplementation(async (task, deadline, leadDays) => ({
      ...task,
      deadline,
      leadDays,
      missingLead: false,
    }));
  const data = await props(actions);
  const template = data.plan.tasks[0]!;
  data.plan.tasks.push(
    {
      ...template,
      id: "insurance",
      title: "Renew the car insurance",
      stage: "none",
      deadline: "2026-11-30",
      leadDays: 0,
      missingLead: true,
    },
    {
      ...template,
      id: "permit",
      title: "Collect the parking permit",
      stage: "none",
      deadline: "2026-10-11",
      leadDays: 0,
      missingLead: true,
      mustStart: true,
    },
  );
  // As the App does: each confirmed task merged into the list.
  function Visit() {
    const [tasks, setTasks] = useState(data.plan.tasks);
    return (
      <PlanView
        {...data}
        plan={{ ...data.plan, tasks }}
        run={async (operation) => {
          const saved = (await operation()) as PlanningTask;
          setTasks((current) =>
            current.map((task) => (task.id === saved.id ? saved : task)),
          );
          return true;
        }}
      />
    );
  }
  render(<Visit />);
  const review = openReview();
  const missing = within(line(review, "2 deadlines have no start-ahead set"));
  // Folded until asked for, then earliest deadline first.
  expect(missing.queryAllByRole("listitem")).toHaveLength(0);
  fireEvent.click(missing.getByRole("button", { name: "Show" }));
  expect(
    missing.getAllByRole("listitem").map((item) => item.textContent),
  ).toEqual([
    expect.stringMatching(/^Collect the parking permit2 days past deadline/u),
    expect.stringMatching(/^Renew the car insurance.*Deadline Nov 30/u),
  ]);
  const select = missing.getByRole("combobox", {
    name: "Start ahead: Collect the parking permit",
  });
  expect(
    [...select.querySelectorAll("option")].map((option) => option.textContent),
  ).toEqual(["Not set", "1 day", "3 days", "7 days", "14 days", "30 days"]);
  fireEvent.change(select, { target: { value: "7" } });
  await waitFor(() =>
    expect(review.getByRole("status").textContent).toBe(
      "Start ahead set: Collect the parking permit",
    ),
  );
  expect(lead.mock.calls[0]).toEqual([
    expect.objectContaining({ id: "permit" }),
    "2026-10-11",
    7,
  ]);
  // The line counts what is left, and focus moves to the next select.
  const next = within(
    line(review, "1 deadline has no start-ahead set"),
  ).getByRole("combobox", { name: "Start ahead: Renew the car insurance" });
  await waitFor(() => expect(document.activeElement).toBe(next));
  // Once every deadline has a lead the line is gone, and focus returns to the heading.
  fireEvent.change(next, { target: { value: "14" } });
  await waitFor(() =>
    expect(
      review.queryByRole("checkbox", { name: /no start-ahead set$/u }),
    ).toBeNull(),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      review.getByRole("heading", { name: "Weekly review" }),
    ),
  );
});

it("counts the five review lines and keeps ticks through Plan's view, for this account week only", async () => {
  // Last week's ticks, as the extension stored them.
  let stored: PlanViewState = {
    ...DEFAULT_PLAN_VIEW,
    review: { week: "2026-10-05", open: false, lines: [1], kept: [] },
  };
  const onPlanView = vi.fn((patch: PlanViewPatch) => {
    stored = mergePlanView(stored, patch);
  });
  const data = await props();
  const onOpenMail = vi.fn();
  const view = render(
    <PlanView
      {...data}
      planView={stored}
      onPlanView={onPlanView}
      onOpenMail={onOpenMail}
    />,
  );
  let review = openReview();
  expect(line(review, "Mail to clarify").textContent).toContain("2");
  // Open shows the host's Mail page, which lists this line's mail.
  fireEvent.click(
    within(line(review, "Mail to clarify")).getByRole("button", {
      name: "Open",
    }),
  );
  expect(onOpenMail).toHaveBeenCalledOnce();
  expect(
    within(line(review, "Mail to clarify")).queryByRole("link"),
  ).toBeNull();
  expect(line(review, "Waiting").textContent).toContain(
    "2oldest untouched 11 days",
  );
  expect(line(review, "Commitments not planned").textContent).toContain("2");
  expect(line(review, "Someday").textContent).toContain("2");
  // Before Sunday line 5 only says where the choice will be, with nothing to tick.
  expect(
    review.queryByRole("checkbox", {
      name: "Reviewed: Next week's commitments and goals",
    }),
  ).toBeNull();
  expect(
    review.getByText(
      "On Sunday, choose commitments to keep and write next week's goals here",
    ),
  ).toBeTruthy();
  expect(review.queryByRole("list", { name: "Next week's goals" })).toBeNull();
  // Another week's ticks show as none.
  const tick = review.getByRole("checkbox", {
    name: "Reviewed: Mail to clarify",
  });
  expect(tick).toHaveProperty("checked", false);
  fireEvent.click(tick);
  // Only line numbers go to the extension, with this account week; the page's storage is not used.
  expect(onPlanView).toHaveBeenLastCalledWith({
    review: { week: "2026-10-12", open: true, lines: [1], kept: [] },
  });
  expect(window.localStorage).toHaveLength(0);
  view.unmount();
  render(<PlanView {...data} planView={stored} onPlanView={onPlanView} />);
  review = within(screen.getByRole("region", { name: "Weekly review" }));
  expect(
    review.getByRole("checkbox", { name: "Reviewed: Mail to clarify" }),
  ).toHaveProperty("checked", true);
  // A week later the list starts again, closed.
  cleanup();
  render(
    <PlanView
      {...data}
      plan={{ ...data.plan, week: "2026-10-19" }}
      planView={stored}
      onPlanView={onPlanView}
    />,
  );
  review = openReview();
  expect(
    review.getByRole("checkbox", { name: "Reviewed: Mail to clarify" }),
  ).toHaveProperty("checked", false);
});

it("reviews someday items oldest first: keeping or moving one leaves the list and moves focus on", async () => {
  const actions = createPrototype();
  const update = vi.spyOn(actions, "updateTask");
  const onPlanView = vi.fn();
  renderApp(actions, onPlanView);
  await screen.findByRole("region", { name: "Committed" });
  const review = openReview();
  const someday = within(line(review, "Someday"));
  // The list stays folded until asked for.
  expect(someday.queryAllByRole("listitem")).toHaveLength(0);
  fireEvent.click(someday.getByRole("button", { name: "Show" }));
  expect(
    someday
      .getAllByRole("listitem")
      .map((item) => item.firstChild?.textContent),
  ).toEqual(["Plan a small balcony garden", "Look into an evening course"]);
  // Moved: once Todoist confirms it is in this month, it no longer counts as still to look at.
  fireEvent.click(
    someday.getByRole("button", {
      name: "Move to this month: Plan a small balcony garden",
    }),
  );
  await waitFor(() => expect(someday.getAllByRole("listitem")).toHaveLength(1));
  // Into this month takes the parked label off too, or Parked would keep it.
  expect(update.mock.calls[0]).toEqual([
    expect.objectContaining({ id: "garden" }),
    { stage: "monthly", parked: false },
  ]);
  expect(line(review, "Someday").textContent).toContain("Someday1");
  const status = review.getByRole("status");
  expect(status.textContent).toBe(
    "Moved to this month: Plan a small balcony garden",
  );
  const keep = someday.getByRole("button", {
    name: "Keep: Look into an evening course",
  });
  await waitFor(() => expect(document.activeElement).toBe(keep));
  // Kept: nothing is written; with the list empty, focus stays on the line.
  fireEvent.click(keep);
  expect(someday.queryAllByRole("listitem")).toHaveLength(0);
  expect(status.textContent).toBe("Kept: Look into an evening course");
  expect(document.activeElement).toBe(
    review.getByRole("checkbox", { name: "Reviewed: Someday" }),
  );
  expect(onPlanView).toHaveBeenLastCalledWith({
    review: { week: "2026-10-12", open: true, lines: [], kept: ["course"] },
  });
  expect(update).toHaveBeenCalledOnce();
});

it("moves an on-hold task into this month with its stage alone", async () => {
  const actions = createPrototype();
  const update = vi.spyOn(actions, "updateTask");
  render(<PlanView {...await props(actions)} />);
  const someday = within(line(openReview(), "Someday"));
  fireEvent.click(someday.getByRole("button", { name: "Show" }));
  fireEvent.click(
    someday.getByRole("button", {
      name: "Move to this month: Look into an evening course",
    }),
  );
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update.mock.calls[0]![1]).toEqual({ stage: "monthly" });
});

it("counts neither a parked task as waiting nor a parked commitment as unplanned", async () => {
  const data = await props();
  const task = (id: string) => data.plan.tasks.find((item) => item.id === id)!;
  // A waiting task and a commitment set aside as well.
  task("venue").planningFlags = [
    ...(task("venue").planningFlags ?? []),
    "parked",
  ];
  task("notes").planningFlags = ["parked"];
  render(<PlanView {...data} />);
  const review = openReview();
  expect([
    line(review, "Waiting").textContent,
    line(review, "Commitments not planned").textContent,
  ]).toEqual([
    "Waiting1oldest untouched 3 daysShow",
    "Commitments not planned1Plan steps",
  ]);
  expect(unscheduledCommitments(data.plan, data.days).map((t) => t.id)).toEqual(
    ["desk"],
  );
});

it("jumps to the Waiting lane, and to the Add steps input of Week's first unplanned commitment", async () => {
  const data = await props();
  render(<PlanView {...data} />);
  const review = openReview();
  // From another area, the jump shows every area so that the lane is on the board.
  fireEvent.click(screen.getByRole("tab", { name: "Personal" }));
  expect(screen.queryByRole("region", { name: "Waiting" })).toBeNull();
  fireEvent.click(
    within(line(review, "Waiting")).getByRole("button", { name: "Show" }),
  );
  expect(
    screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(document.activeElement).toBe(
    screen.getByRole("region", { name: "Waiting" }),
  );
  fireEvent.click(
    within(line(review, "Commitments not planned")).getByRole("button", {
      name: "Plan steps",
    }),
  );
  expect(
    screen.getByRole("tab", { name: "Week" }).getAttribute("aria-selected"),
  ).toBe("true");
  const tray = within(
    screen.getByRole("region", {
      name: "Next steps: Organize the experiment notes",
    }),
  );
  // Its Add steps input is open and focused, ready for the first step.
  expect(document.activeElement).toBe(
    tray.getByRole("textbox", { name: "New step" }),
  );
  // One quiet line, no per-card mark; each click selects the next one, which closes the input.
  const runway = screen.getByRole("button", {
    name: "2 commitments have nothing planned in these 7 days",
  });
  expect(runway.title).toBe("Select the next one");
  fireEvent.click(runway);
  const next = within(
    screen.getByRole("region", {
      name: "Next steps: Make the home desk comfortable",
    }),
  );
  expect(next.queryByRole("textbox")).toBeNull();
  expect(
    next.getByRole("button", {
      name: "Add steps to “Make the home desk comfortable”",
    }),
  ).toBeTruthy();
  // Closing the checklist returns focus to the toolbar button that opened it.
  fireEvent.click(review.getByRole("button", { name: "Close" }));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Weekly review" }),
  );
});

it("Plan steps also works while Week is open, folded, on another commitment and area", async () => {
  const data = await props();
  render(<PlanView {...data} />);
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  const weekArea = within(
    screen.getByRole("tablist", { name: "Commitment area", hidden: true }),
  );
  fireEvent.click(weekArea.getByRole("tab", { name: "Personal" }));
  expect(
    screen.getByRole("region", {
      name: "Next steps: Make the home desk comfortable",
    }),
  ).toBeTruthy();
  const toggle = screen.getByRole("button", { name: "Committed" });
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  const review = openReview();
  fireEvent.click(
    within(line(review, "Commitments not planned")).getByRole("button", {
      name: "Plan steps",
    }),
  );
  // Unfolded with every area again, so that the first unplanned commitment's card is in the grid.
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(
    weekArea.getByRole("tab", { name: "All" }).getAttribute("aria-selected"),
  ).toBe("true");
  const tray = within(
    screen.getByRole("region", {
      name: "Next steps: Organize the experiment notes",
    }),
  );
  expect(document.activeElement).toBe(
    tray.getByRole("textbox", { name: "New step" }),
  );
});

it("keeps this week's commitments for next week only on Sunday, when clicked", async () => {
  const actions = createPrototype(false, "2026-10-18");
  const update = vi.spyOn(actions, "updateTask");
  renderApp(actions);
  await screen.findByRole("region", { name: "Committed" });
  // A commitment saved on Sunday from the board is kept already: no second write is offered.
  fireEvent.click(
    screen.getByRole("button", { name: /^Try the new charting library,/u }),
  );
  const editor = within(screen.getByRole("region", { name: "Steps & timing" }));
  fireEvent.change(editor.getByLabelText("Planning"), {
    target: { value: "committed" },
  });
  fireEvent.click(
    editor
      .getAllByRole("button", { name: "Save" })
      .find((button) => !(button as HTMLButtonElement).disabled)!,
  );
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  fireEvent.click(editor.getByRole("button", { name: "Close" }));
  const review = openReview();
  const next = within(line(review, "Next week's commitments and goals"));
  expect(next.getByText(/chosen in Plan on Sunday/u)).toBeTruthy();
  // Release, research, notes and desk are this week's; the charting library is kept.
  fireEvent.click(
    next.getByRole("button", { name: "Choose commitments to keep (4)" }),
  );
  const row = (title: string) =>
    within(
      next
        .getAllByRole("listitem")
        .find((item) => item.textContent?.startsWith(title))!,
    );
  expect(
    row("Try the new charting library").getByText("Kept for next week"),
  ).toBeTruthy();
  fireEvent.click(
    next.getByRole("button", {
      name: "Keep for next week: Prepare the next research check-in",
    }),
  );
  await waitFor(() =>
    expect(
      row("Prepare the next research check-in").getByText("Kept for next week"),
    ).toBeTruthy(),
  );
  expect(review.getByRole("status").textContent).toBe(
    "Kept for next week: Prepare the next research check-in",
  );
  // Focus moves to the next item still to keep.
  await waitFor(() =>
    expect(document.activeElement).toBe(
      next.getByRole("button", {
        name: "Keep for next week: Organize the experiment notes",
      }),
    ),
  );
  expect(
    next.getByRole("button", { name: "Hide" }).getAttribute("aria-expanded"),
  ).toBe("true");
  expect(update.mock.calls.map(([task, change]) => [task.id, change])).toEqual([
    ["tools", { stage: "committed" }],
    ["research", { stage: "committed" }],
  ]);
});

it("writes next week's two Bets in Sunday's fifth line, apart from the commitments", async () => {
  const actions = createPrototype(false, "2026-10-18");
  const save = vi.spyOn(actions, "setWeeklyBet");
  const update = vi.spyOn(actions, "updateTask");
  renderApp(actions);
  await screen.findByRole("region", { name: "Committed" });
  const review = openReview();
  const next = within(line(review, "Next week's commitments and goals"));
  // Only commitments are choices to keep; the goals are text.
  expect(next.getByRole("button", { name: "Choose commitments to keep (4)" }));
  const goals = within(next.getByRole("list", { name: "Next week's goals" }));
  expect(
    goals.getAllByRole("listitem").map((item) => item.textContent),
  ).toEqual([
    "WorkWrite next week's work goal",
    "PersonalWrite next week's personal goal",
  ]);
  fireEvent.click(
    goals.getByRole("button", { name: "Write next week's work goal" }),
  );
  const input = goals.getByRole("textbox", { name: "Next week's work goal" });
  expect(document.activeElement).toBe(input);
  fireEvent.change(input, { target: { value: "Draft the  quarter plan " } });
  fireEvent.keyDown(input, { key: "Enter" });
  const saved = await goals.findByRole("button", {
    name: "Edit next week's work goal: Draft the quarter plan",
  });
  expect(save.mock.calls).toEqual([
    [
      {
        weekStart: "2026-10-19",
        area: "work",
        text: "Draft the quarter plan",
        etag: "",
      },
    ],
  ]);
  await waitFor(() => expect(document.activeElement).toBe(saved));
  expect(review.getByRole("status").textContent).toBe(
    "Next week's work goal saved",
  );
  // No "keep this week's" here: carrying a goal on is Monday's Keep only.
  expect(next.queryByRole("button", { name: /^Keep last week/u })).toBeNull();
  expect(update).not.toHaveBeenCalled();
});

it("completes the review task only when Finish review is clicked, outside Focus", async () => {
  const actions = createPrototype();
  const complete = vi.spyOn(actions, "completeTask");
  render(
    <App
      actions={actions}
      view="plan"
      language="en"
      onOpenTask={() => {}}
      onSettings={() => {}}
      review
    />,
  );
  const review = within(
    await screen.findByRole("region", { name: "Weekly review" }),
  );
  expect(complete).not.toHaveBeenCalled();
  fireEvent.click(review.getByRole("button", { name: "Finish review" }));
  await waitFor(() => expect(complete).toHaveBeenCalledOnce());
  const [task, requestId, flowDate] = complete.mock.calls[0]!;
  expect([task.id, typeof requestId, flowDate]).toEqual([
    "weekly-review",
    "string",
    "",
  ]);
  // The re-read no longer lists the closed task.
  await waitFor(() =>
    expect(review.getByRole("status").textContent).toBe(
      "Review task completed",
    ),
  );
  expect(review.getAllByText("Review task completed")).toHaveLength(2);
  expect(document.activeElement).toBe(
    review.getByRole("heading", { name: "Weekly review" }),
  );
});

it("maps a task's last change and the review IDs from the API", async () => {
  const api = fakeActions(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/api/plus/v1/plan:read")
      return Response.json({
        plan: {
          week_start: "2026-10-12",
          today: "2026-10-13",
          timezone: "UTC",
          enabled: true,
          review_task_id: "review",
          next_week_task_ids: ["kept"],
        },
      });
    if (path === "/api/plus/v1/tasks")
      return Response.json({
        planning_tasks: [
          {
            id: "a",
            title: "Synthetic a",
            update_time: "2026-10-01T16:00:00Z",
          },
          { id: "b", title: "Synthetic b" },
        ],
      });
    if (path.endsWith("/timerSession"))
      return Response.json({ name: "timerSession", etag: "0" });
    if (path.endsWith("/tasks")) return Response.json({ tasks: [] });
    return Response.json({ name: path.slice(path.indexOf("flows/")) });
  });
  const { plan } = await api.load();
  expect([plan.reviewTaskId, plan.nextWeekTaskIds]).toEqual([
    "review",
    ["kept"],
  ]);
  expect(plan.tasks.map((task: PlanningTask) => task.updatedAt)).toEqual([
    "2026-10-01T16:00:00.000Z",
    undefined,
  ]);
});
