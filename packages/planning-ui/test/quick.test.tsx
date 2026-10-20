import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlanView } from "../src/PlanView";
import { addDays } from "../src/domain";
import { quickTasks, quickTray } from "../src/weekly-review";
import { createPrototype } from "./fixture";
import type { PlanningTask } from "../src/model";

afterEach(cleanup);

// The fixture's today; Los Angeles is UTC-7 on these days.
const TODAY = "2026-10-13";
const on = (days: number) => addDays(TODAY, days);
const task = (id: string, value: Partial<PlanningTask> = {}): PlanningTask => ({
  id,
  title: `Synthetic ${id}`,
  parentId: "",
  projectId: "synthetic",
  labels: ["quick"],
  area: "work",
  stage: "none",
  priority: 1,
  deadline: "",
  due: "",
  leadDays: 0,
  etag: id,
  mustStart: false,
  missingLead: false,
  ...value,
});
const ids = (tasks: PlanningTask[]) => tasks.map((item) => item.id);
const quick = (tasks: PlanningTask[]) =>
  ids(quickTasks({ tasks, timezone: "America/Los_Angeles" }, TODAY));

it("shows what the native Quick / Ops filter shows: no date, or due or a deadline within three days", () => {
  expect(
    quick([
      task("overdue", { due: on(-3) }),
      task("last-day", { due: on(2) }),
      task("too-late", { due: on(3) }),
      task("undated"),
      task("deadline", { due: on(8), deadline: on(2) }),
      task("timed", { due: `${on(2)}T09:00:00` }),
      // Half an hour before local midnight after the last day: in, though its UTC day is not.
      task("fixed-in", { due: `${on(3)}T06:30:00Z` }),
      task("fixed-out", { due: `${on(3)}T07:30:00Z` }),
      task("other-label", { labels: ["quickly"] }),
    ]),
  ).toEqual([
    "overdue",
    "last-day",
    "timed",
    "fixed-in",
    // Shown for its deadline, sorted by its due day.
    "deadline",
    "undated",
  ]);
});

it("lists dated tasks first by day, then the undated, the higher priority first within each", () => {
  expect(
    quick([
      task("undated-low"),
      task("tomorrow", { due: on(1) }),
      task("undated-high", { priority: 4 }),
      task("today-low", { due: TODAY }),
      task("today-high", { due: TODAY, priority: 3 }),
    ]),
  ).toEqual([
    "today-high",
    "today-low",
    "tomorrow",
    "undated-high",
    "undated-low",
  ]);
});

it("leaves out of Week's line what is in a shown day, a next step above it, or set aside", () => {
  const tasks = [
    task("queued"),
    task("done-there"),
    task("step"),
    task("parked", { labels: ["quick", "parked"] }),
    task("free"),
  ];
  const days = [
    {
      date: TODAY,
      taskIds: ["queued", "done-there"],
      completedTaskIds: ["done-there"],
    },
  ];
  const plan = { tasks, timezone: "UTC" };
  // A parked task is in Review's Parked lane instead.
  expect(ids(quickTray(plan, TODAY, days, [tasks[2]!]))).toEqual([
    "done-there",
    "free",
  ]);
});

it("shows Week's quick tasks as a quiet line of equal one-line cards under Next steps, six before more", async () => {
  const actions = createPrototype();
  const data = await actions.load();
  const template = data.plan.tasks.find((item) => item.id === "receipt")!;
  for (let index = 1; index <= 8; index++)
    data.plan.tasks.push({
      ...template,
      id: `quick-${index}`,
      title: `Synthetic quick task ${index}`,
    });
  const editTask = vi.fn();
  render(
    <PlanView
      plan={data.plan}
      days={data.days}
      focusTasks={data.focus.tasks}
      currentDate={data.focus.date}
      language="en"
      busy={false}
      actions={actions}
      run={vi.fn()}
      editTask={editTask}
      onWeekChange={vi.fn()}
      completeTask={vi.fn()}
      completeReview={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Week" }));
  const line = screen.getByRole("region", { name: "Quick tasks" });
  // After the steps tray and before the calendar.
  const week = document.querySelector(".planning-week")!;
  expect(
    [...week.children]
      // The drag instructions, which only the handles' description reads.
      .filter((child) => !(child as HTMLElement).hidden)
      .map((child) => child.className.split(" ")[0]),
  ).toEqual([
    "planning-commitment-heading",
    "planning-commitment-grid",
    "planning-step-tray",
    "planning-quick",
    "planning-calendar",
  ]);
  // Today's queued receipt is in the calendar, not here.
  expect(within(line).getByRole("heading").textContent).toBe("Quick tasks8");
  const cards = line.querySelectorAll(".planning-quick-card");
  expect(cards).toHaveLength(6);
  expect(
    within(cards[0] as HTMLElement).getByRole("button", {
      name: "Drag quick task: Synthetic quick task 1",
    }),
  ).toBeTruthy();
  // The edge colour says the area, and so does the title's name.
  const title = within(cards[0] as HTMLElement).getByRole("button", {
    name: "Synthetic quick task 1, Work",
  });
  expect((cards[0] as HTMLElement).style.getPropertyValue("--area-color")).toBe(
    "var(--plus-area-work)",
  );
  // The full title floats from FullTitle on hover or focus, not from a second, native tooltip.
  expect(title.hasAttribute("title")).toBe(false);
  expect(title.querySelector(".planning-full-title-text")?.textContent).toBe(
    "Synthetic quick task 1",
  );
  fireEvent.click(title);
  expect(editTask).toHaveBeenCalledWith(
    expect.objectContaining({ id: "quick-1" }),
  );
  // "N more" follows the heading's count, so it never takes a card's cell.
  const more = within(line).getByRole("button", { name: "2 more" });
  expect(more.closest(".planning-quick-heading")).toBeTruthy();
  expect(more.closest("ul")).toBeNull();
  expect(line.querySelector("ul")!.children).toHaveLength(6);
  fireEvent.click(more);
  expect(line.querySelectorAll(".planning-quick-card")).toHaveLength(8);
  expect(line.querySelector("ul")!.children).toHaveLength(8);
  const fewer = within(line).getByRole("button", { name: "Show fewer" });
  expect(fewer.ariaExpanded).toBe("true");
  expect(fewer.closest(".planning-quick-heading")).toBeTruthy();
});

it("shows no Quick line without a quick task to plan", async () => {
  const actions = createPrototype();
  const data = await actions.load();
  render(
    <PlanView
      plan={data.plan}
      days={data.days}
      focusTasks={data.focus.tasks}
      currentDate={data.focus.date}
      language="zh"
      busy={false}
      actions={actions}
      run={vi.fn()}
      editTask={vi.fn()}
      onWeekChange={vi.fn()}
      completeTask={vi.fn()}
      completeReview={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "一周安排" }));
  expect(screen.queryByRole("region", { name: "快速事项" })).toBeNull();
});
