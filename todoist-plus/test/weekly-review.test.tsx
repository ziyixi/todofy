import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { createApi } from "../src/api";
import { PlanView, type PlanViewProps } from "../src/PlanView";
import {
  inboxToClarify,
  isoWeek,
  oldestUntouched,
  unscheduledCommitments,
  untouchedDays,
  WAITING_LABELS,
} from "../src/weekly-review";
import { createPrototype } from "../design/fixture";
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
    todayTaskIds: focus.taskIds,
    addFocus: vi.fn(),
    addStep: vi.fn(),
    onOpenTask: vi.fn(),
    completeReview: vi.fn(async () => true),
  };
}
function openReview() {
  fireEvent.click(screen.getByRole("button", { name: "Weekly review" }));
  return within(screen.getByRole("region", { name: "Weekly review" }));
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
  // Top-level mail tasks without a stage; the review task and planned or waiting tasks are not.
  const mail = plan.tasks.find((task) => task.id === "mail-notes")!;
  plan.tasks.push(
    { ...mail, id: "mail-step", parentId: "mail-notes" },
    { ...mail, id: "mail-weekly", stage: "weekly" },
    { ...mail, id: "mail-waiting", labels: ["waiting"] },
  );
  expect(inboxToClarify(plan).map((task) => task.id)).toEqual([
    "mail-register",
    "mail-notes",
  ]);
  expect(inboxToClarify({ ...plan, inboxProjectId: "" })).toEqual([]);
  // Notes has no step and Desk's step is not in any of the seven days.
  expect(unscheduledCommitments(plan, days).map((task) => task.id)).toEqual([
    "notes",
    "desk",
  ]);
});

it("lists waiting tasks oldest first behind one collapsed row, with the owner's own actions", async () => {
  const data = await props();
  render(<PlanView {...data} todayTaskIds={["access"]} />);
  const row = screen.getByText("Waiting (2)").closest("details")!;
  expect(row.open).toBe(false);
  fireEvent.click(screen.getByText("Waiting (2)"));
  const list = within(screen.getByRole("list", { name: "Waiting" }));
  const items = list.getAllByRole("listitem");
  expect(items.map((item) => item.textContent)).toEqual([
    expect.stringContaining("Hear back about the venue quoteUntouched 11 days"),
    expect.stringContaining("Lab access approvalUntouched 3 days"),
  ]);
  fireEvent.click(
    list.getByRole("button", {
      name: "Add follow-up step: Hear back about the venue quote",
    }),
  );
  expect(data.addStep).toHaveBeenCalledWith(
    expect.objectContaining({ id: "venue" }),
  );
  fireEvent.click(
    list.getByRole("button", {
      name: "Add to today: Hear back about the venue quote",
    }),
  );
  expect(data.addFocus).toHaveBeenCalledWith("venue");
  expect(
    list.getByRole("button", { name: "In today: Lab access approval" }),
  ).toHaveProperty("disabled", true);
  fireEvent.click(
    list.getByRole("button", {
      name: "Open in Todoist: Lab access approval",
    }),
  );
  expect(data.onOpenTask).toHaveBeenCalledWith("access");
  // Nothing was written: no label is removed and nobody is contacted.
  expect(data.run).not.toHaveBeenCalled();
});

it("counts the five review lines and keeps ticks for this ISO week only", async () => {
  window.localStorage.setItem(
    "todoist-plus:review:2026-W41",
    JSON.stringify({ lines: [1], kept: [] }),
  );
  const data = await props();
  const view = render(<PlanView {...data} />);
  let review = openReview();
  expect(line(review, "Inbox to clarify").textContent).toContain("2");
  expect(
    within(line(review, "Inbox to clarify"))
      .getByRole("link", { name: /Open in Todoist/u })
      .getAttribute("href"),
  ).toBe("https://app.todoist.com/app/project/synthetic-mail");
  expect(line(review, "Waiting").textContent).toContain(
    "2oldest untouched 11 days",
  );
  expect(line(review, "Commitments not planned").textContent).toContain("2");
  expect(line(review, "Someday").textContent).toContain("2");
  expect(line(review, "Next week's commitments").textContent).toContain(
    "chosen on Sunday stay for next week",
  );
  const tick = review.getByRole("checkbox", {
    name: "Reviewed: Inbox to clarify",
  });
  expect(tick).toHaveProperty("checked", false);
  fireEvent.click(tick);
  expect(
    JSON.parse(window.localStorage.getItem("todoist-plus:review:2026-W42")!),
  ).toEqual({ lines: [1], kept: [] });
  // Older weeks' ticks are dropped; only IDs and line numbers are stored.
  expect(
    window.localStorage.getItem("todoist-plus:review:2026-W41"),
  ).toBeNull();
  view.unmount();
  render(<PlanView {...data} />);
  review = openReview();
  expect(
    review.getByRole("checkbox", { name: "Reviewed: Inbox to clarify" }),
  ).toHaveProperty("checked", true);
  // A week later the list starts again.
  cleanup();
  render(<PlanView {...data} plan={{ ...data.plan, week: "2026-10-19" }} />);
  review = openReview();
  expect(
    review.getByRole("checkbox", { name: "Reviewed: Inbox to clarify" }),
  ).toHaveProperty("checked", false);
});

it("reviews someday items oldest first: move one to this month or keep it", async () => {
  const actions = createPrototype();
  const update = vi.spyOn(actions, "updateTask");
  const data = await props(actions);
  render(<PlanView {...data} />);
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
  fireEvent.click(someday.getAllByRole("button", { name: "Keep" })[0]!);
  expect(someday.getAllByRole("listitem")).toHaveLength(1);
  expect(
    JSON.parse(window.localStorage.getItem("todoist-plus:review:2026-W42")!)
      .kept,
  ).toEqual(["garden"]);
  fireEvent.click(someday.getByRole("button", { name: "Move to this month" }));
  await waitFor(() => expect(update).toHaveBeenCalledOnce());
  expect(update.mock.calls[0]).toEqual([
    expect.objectContaining({ id: "course" }),
    { stage: "monthly" },
  ]);
});

it("jumps to the Waiting row and to Week's first unplanned commitment", async () => {
  const data = await props();
  render(<PlanView {...data} />);
  const review = openReview();
  fireEvent.click(
    within(line(review, "Waiting")).getByRole("button", { name: "Show" }),
  );
  expect(screen.getByText("Waiting (2)").closest("details")!.open).toBe(true);
  fireEvent.click(
    within(line(review, "Commitments not planned")).getByRole("button", {
      name: "Plan steps",
    }),
  );
  expect(
    screen.getByRole("tab", { name: "Week" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(
    screen.getByRole("region", {
      name: "Next steps: Organize the experiment notes",
    }),
  ).toBeTruthy();
  // One quiet line, no per-card mark; each click selects the next one.
  fireEvent.click(
    screen.getByRole("button", {
      name: "2 commitments have nothing planned in these 7 days",
    }),
  );
  expect(
    screen.getByRole("region", {
      name: "Next steps: Make the home desk comfortable",
    }),
  ).toBeTruthy();
});

it("keeps this week's commitments and goals for next week only on Sunday, when clicked", async () => {
  const actions = createPrototype();
  const update = vi.spyOn(actions, "updateTask");
  const data = await props(actions);
  const template = data.plan.tasks[0]!;
  data.plan.tasks.push({
    ...template,
    id: "goal",
    title: "A goal without a commitment",
    stage: "none",
    bet: true,
  });
  data.plan.nextWeekTaskIds = ["notes"];
  render(<PlanView {...data} />);
  // On a weekday the line only states the rule.
  expect(
    within(line(openReview(), "Next week's commitments")).queryAllByRole(
      "button",
    ),
  ).toHaveLength(0);
  cleanup();
  render(<PlanView {...data} currentDate="2026-10-18" />);
  const next = within(line(openReview(), "Next week's commitments"));
  // Notes is already recorded for next week: four of the five can still be kept.
  fireEvent.click(next.getByRole("button", { name: "Choose what stays (4)" }));
  const rows = next.getAllByRole("listitem");
  const row = (title: string) =>
    within(rows.find((item) => item.textContent?.startsWith(title))!);
  expect(
    row("Organize the experiment notes").getByText("Kept for next week"),
  ).toBeTruthy();
  expect(update).not.toHaveBeenCalled();
  fireEvent.click(
    row("Prepare the next research check-in").getByRole("button", {
      name: "Keep for next week",
    }),
  );
  await waitFor(() =>
    expect(
      row("Prepare the next research check-in").getByText("Kept for next week"),
    ).toBeTruthy(),
  );
  fireEvent.click(
    row("A goal without a commitment").getByRole("button", {
      name: "Keep for next week",
    }),
  );
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
  expect(update.mock.calls.map(([task, change]) => [task.id, change])).toEqual([
    ["research", { stage: "committed" }],
    ["goal", { bet: true }],
  ]);
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
  expect(await review.findByText("Review task completed")).toBeTruthy();
});

it("opens a waiting task's step editor empty, ready for a follow-up step", async () => {
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
  fireEvent.click(await screen.findByText("Waiting (2)"));
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: "Add follow-up step: Lab access approval",
      }),
    );
  });
  const editor = screen.getByRole("region", { name: "Steps & timing" });
  expect(within(editor).getByRole("heading", { level: 2 }).textContent).toBe(
    "Lab access approval",
  );
  const entry = editor.querySelector("textarea")!;
  expect(entry.value).toBe("");
  expect(document.activeElement).toBe(entry);
});

it("maps Todoist's last change and the review IDs from the API", async () => {
  const api = createApi(
    { apiOrigin: "https://api.example.test", token: "synthetic" },
    async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/plus/v1/plan:read")
        return Response.json({
          plan: {
            week_start: "2026-10-12",
            today: "2026-10-13",
            timezone: "UTC",
            enabled: true,
            inbox_project_id: "mail",
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
    },
  );
  const { plan } = await api.load();
  expect([
    plan.inboxProjectId,
    plan.reviewTaskId,
    plan.nextWeekTaskIds,
  ]).toEqual(["mail", "review", ["kept"]]);
  expect(plan.tasks.map((task: PlanningTask) => task.updatedAt)).toEqual([
    "2026-10-01T16:00:00.000Z",
    undefined,
  ]);
});
