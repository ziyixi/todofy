import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlanView, type PlanViewProps } from "../src/PlanView";
import { TaskBreadcrumb } from "../src/TaskBreadcrumb";
import {
  DEFAULT_PLAN_VIEW,
  mergePlanView,
  type PlanViewPatch,
  type PlanViewState,
} from "../src/plan-view-state";
import { createPrototype } from "./fixture";

afterEach(cleanup);
async function props(): Promise<PlanViewProps> {
  const actions = createPrototype();
  const { plan, focus, days } = await actions.load();
  return {
    plan,
    days,
    focusTasks: focus.tasks,
    currentDate: focus.date,
    language: "en",
    busy: false,
    actions,
    run: vi.fn(),
    editTask: vi.fn(),
    onWeekChange: vi.fn(),
    completeTask: vi.fn(),
    completeReview: vi.fn(),
  };
}
function openWeek() {
  fireEvent.click(screen.getByRole("tab", { name: /^Week$/u }));
}
/** A store like the extension's: every patch PlanView sends, merged into one view. */
function viewStore(initial: PlanViewState = DEFAULT_PLAN_VIEW) {
  const store = {
    view: initial,
    patches: [] as PlanViewPatch[],
    onPlanView: (patch: PlanViewPatch) => {
      store.patches.push(patch);
      store.view = mergePlanView(store.view, patch);
    },
  };
  return store;
}

it("opens Review with four real stages and keeps an unplanned task outside the commitment count", async () => {
  const data = await props();
  const template = data.plan.tasks[0]!;
  data.plan.tasks.push(
    {
      ...template,
      id: "unplanned",
      title: "Independent unplanned task",
      stage: "none",
      parentId: "",
    },
    {
      ...template,
      id: "quarter-outcome",
      title: "Explore the next direction",
      stage: "quarterly",
      parentId: "",
    },
  );
  render(<PlanView {...data} />);
  expect(screen.getByRole("region", { name: "Quarter" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Month" })).toBeTruthy();
  expect(screen.getByRole("region", { name: "Week" })).toBeTruthy();
  const committed = within(screen.getByRole("region", { name: "Committed" }));
  expect(
    committed.getAllByRole("button", { name: /No priority/u }),
  ).toHaveLength(3);
  expect(
    within(screen.getByRole("region", { name: "Parked" })).getByRole("button", {
      name: /^Prepare the next research check-in, Work, No priority/u,
    }),
  ).toBeTruthy();
  expect(screen.queryByText("Independent unplanned task")).toBeNull();
  expect(screen.getByText("3/5 work · 1/3 personal")).toBeTruthy();
});

it("expands one commitment into its real recursive leaf steps without absorbing an independent child stage", async () => {
  const data = await props();
  const copy = data.plan.tasks.find((task) => task.id === "copy")!;
  data.plan.tasks.push(
    {
      ...copy,
      id: "sentence",
      title: "Polish one sentence",
      parentId: "copy",
      estimatedMinutes: 15,
    },
    {
      ...copy,
      id: "independent",
      title: "Independent weekly action",
      parentId: "release",
      stage: "weekly",
    },
  );
  render(<PlanView {...data} />);
  openWeek();
  const tray = within(
    screen.getByRole("region", {
      name: "Next steps: Ship the small website refresh",
    }),
  );
  expect(
    tray.getByRole("button", { name: /^Polish one sentence/u }),
  ).toBeTruthy();
  expect(
    tray.getByRole("button", { name: /^Check the layout on a phone/u }),
  ).toBeTruthy();
  expect(
    tray.queryByRole("button", { name: /^Write the introduction/u }),
  ).toBeNull();
  expect(tray.queryByText("Independent weekly action")).toBeNull();
  expect(
    screen
      .getByRole("region", { name: "Weekly planning" })
      .querySelectorAll(".planning-commitment-grid [data-outcome-id]"),
  ).toHaveLength(4);
});

it("keeps week navigation usable during a save without changing the current commitment period", async () => {
  const data = await props();
  data.busy = true;
  render(<PlanView {...data} />);
  openWeek();
  const previous = screen.getByRole("button", { name: "Previous week" });
  const next = screen.getByRole("button", { name: "Next week" });
  expect((previous as HTMLButtonElement).disabled).toBe(false);
  expect((next as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(previous);
  fireEvent.click(next);
  expect(data.onWeekChange).toHaveBeenNthCalledWith(1, "2026-10-05");
  expect(data.onWeekChange).toHaveBeenNthCalledWith(2, "2026-10-19");
  expect(screen.getByText("3/5 work · 1/3 personal")).toBeTruthy();
});

it("distinguishes two planning outcomes under the same project and keeps queued tasks Plan does not list", async () => {
  const data = await props();
  const parent = data.plan.tasks[0]!;
  data.plan.tasks.push({
    ...parent,
    id: "project",
    title: "Shared project",
    parentId: "",
    stage: "none",
  });
  data.plan.tasks = data.plan.tasks.map((task) =>
    ["release", "research"].includes(task.id)
      ? { ...task, parentId: "project" }
      : task,
  );
  data.days[1]!.taskIds = ["copy", "outline", "unlisted", "missing"];
  // A task Plan's list leaves out has its title from Tasks' Focus read.
  data.focusTasks["unlisted"] = {
    title: "Synthetic unlisted step",
    parentId: "elsewhere",
    parentTitle: "Synthetic other outcome",
    estimatedMinutes: 15,
    completed: false,
  };
  render(<PlanView {...data} />);
  openWeek();
  const card = (id: string) =>
    document.querySelector<HTMLElement>(
      `.planning-calendar-step[data-task-id="${id}"]`,
    )!;
  expect(
    card("copy").querySelector(".planning-calendar-step-meta > span")
      ?.textContent,
  ).toBe("Ship the small website refresh");
  expect(
    card("outline").querySelector(".planning-calendar-step-meta > span")
      ?.textContent,
  ).toBe("Prepare the next research check-in");
  // The edge colour is the area, not the outcome: two work outcomes share it, and a task Plan
  // does not list shows none.
  expect(card("copy").style.getPropertyValue("--area-color")).toBe(
    "var(--plus-area-work)",
  );
  expect(card("outline").style.getPropertyValue("--area-color")).toBe(
    "var(--plus-area-work)",
  );
  expect(card("unlisted").style.getPropertyValue("--area-color")).toBe(
    "var(--plus-area-none)",
  );
  expect(card("unlisted").textContent).toContain("Synthetic unlisted step");
  expect(card("unlisted").textContent).toContain("Synthetic other outcome");
  expect(card("unlisted").textContent).toContain("15m");
  expect(card("missing").textContent).toContain("Task unavailable");
});

it("keeps the steps done from a day after its open ones: done, fixed and outside the day's total", async () => {
  const data = await props();
  const onOpenTask = vi.fn();
  const today = data.days[1]!;
  today.taskIds = ["copy", "outline"];
  // Plan's list leaves out a done step: its title is from Tasks' Focus read, else unavailable.
  today.completedTaskIds = ["finished", "gone"];
  data.focusTasks["finished"] = {
    title: "Synthetic finished step",
    parentId: "release",
    parentTitle: "Ship the small website refresh",
    estimatedMinutes: 45,
    completed: true,
  };
  render(<PlanView {...data} onOpenTask={onOpenTask} />);
  openWeek();
  const column = document.querySelector<HTMLElement>(
    `.planning-calendar-day[data-date="${today.date}"]`,
  )!;
  expect(
    [...column.querySelectorAll<HTMLElement>(".planning-calendar-step")].map(
      (card) => [card.dataset.taskId, card.classList.contains("is-done")],
    ),
  ).toEqual([
    ["copy", false],
    ["outline", false],
    ["finished", true],
    ["gone", true],
  ]);
  // The total is the open steps' 30m and 1h; the done step's 45m is not in it.
  expect(column.querySelector(".planning-day-heading small")?.textContent).toBe(
    "1h 30m",
  );
  const finished = column.querySelector<HTMLElement>(
    '[data-task-id="finished"]',
  )!;
  // One control: its title, named done. No grip, completion or removal.
  expect(
    within(finished)
      .getAllByRole("button")
      .map((button) => button.textContent),
  ).toEqual(["Completed: Synthetic finished step"]);
  expect(finished.textContent).toContain("Ship the small website refresh");
  expect(finished.textContent).toContain("45m");
  // Its parent's area colour, as in Focus.
  expect(finished.style.getPropertyValue("--area-color")).toBe(
    "var(--plus-area-work)",
  );
  expect(finished.querySelector(".plus-checkbox.is-done")).toBeTruthy();
  // The planning panel needs an open task: Tasks' own dialog opens, where it can be reopened.
  fireEvent.click(
    within(finished).getByRole("button", {
      name: "Completed: Synthetic finished step",
    }),
  );
  expect(onOpenTask).toHaveBeenCalledWith("finished");
  expect(data.editTask).not.toHaveBeenCalled();
  const gone = column.querySelector<HTMLElement>('[data-task-id="gone"]')!;
  expect(
    within(gone).getByRole("button", { name: "Completed: Task unavailable" }),
  ).toBeTruthy();
  expect(gone.style.getPropertyValue("--area-color")).toBe(
    "var(--plus-area-none)",
  );
  expect(gone.textContent).toContain("?");
});

it("names a done calendar step done in Chinese, and leaves its title still without a host dialog", async () => {
  const data = await props();
  data.days[1]!.completedTaskIds = ["copy"];
  data.days[1]!.taskIds = ["outline"];
  render(<PlanView {...data} language="zh" />);
  fireEvent.click(screen.getByRole("tab", { name: "一周安排" }));
  const done = document.querySelector<HTMLElement>(
    '.planning-calendar-step.is-done[data-task-id="copy"]',
  )!;
  // A repeating step stays in Plan's list after a completion: its title and area are Plan's.
  expect(
    within(done).getByText("Write the introduction", { exact: false })
      .textContent,
  ).toBe("已完成: Write the introduction");
  expect(done.textContent).toContain("Ship the small website refresh");
  expect(done.querySelector("button")).toBeNull();
  expect(done.style.getPropertyValue("--area-color")).toBe(
    "var(--plus-area-work)",
  );
});

it("draws each card's edge in its area's colour, with Work and Personal dots as the legend", async () => {
  const data = await props();
  render(<PlanView {...data} />);
  const edge = (id: string) =>
    document
      .querySelector<HTMLElement>(
        `.planning-outcome-card[data-outcome-id="${id}"]`,
      )!
      .style.getPropertyValue("--area-color");
  expect(edge("release")).toBe("var(--plus-area-work)");
  expect(edge("notes")).toBe("var(--plus-area-work)");
  expect(edge("desk")).toBe("var(--plus-area-personal)");
  const legend = () =>
    screen
      .getAllByRole("tab")
      .filter((tab) => tab.closest(".planning-area-filter"))
      .map((tab) => [tab.textContent, tab.dataset.area ?? ""]);
  expect(legend()).toEqual([
    ["All", ""],
    ["Work", "work"],
    ["Personal", "personal"],
  ]);
  openWeek();
  expect(legend()).toEqual([
    ["All", ""],
    ["Work", "work"],
    ["Personal", "personal"],
  ]);
  // The selected commitment's steps and its tray header share its area.
  const tray = document.querySelector<HTMLElement>(".planning-step-tray")!;
  expect(tray.style.getPropertyValue("--area-color")).toBe(
    "var(--plus-area-work)",
  );
  for (const step of tray.querySelectorAll<HTMLElement>(
    ".planning-tray-step[data-task-id]",
  ))
    expect(step.style.getPropertyValue("--area-color")).toBe(
      "var(--plus-area-work)",
    );
});

it("draws the breadcrumb's bar in the task's area colour", async () => {
  const { plan } = await props();
  const step = plan.tasks.find((task) => task.id === "measure")!;
  render(<TaskBreadcrumb task={step} tasks={plan.tasks} language="en" />);
  const crumb = screen.getByLabelText("Parent task");
  expect(crumb.textContent).toBe("Make the home desk comfortable");
  expect(crumb.style.getPropertyValue("--area-color")).toBe(
    "var(--plus-area-personal)",
  );
});

it("keeps timed steps readable while preventing their move, and marks rather than rejects long steps", async () => {
  const data = await props();
  const task = data.plan.tasks.find((task) => task.id === "copy")!;
  task.estimatedMinutes = 120;
  data.timer = {
    taskId: "copy",
    day: data.currentDate,
    area: "work",
    status: "paused",
    elapsedSeconds: 60,
    startedAt: "2026-10-13T10:00:00Z",
    etag: "active",
  };
  render(<PlanView {...data} />);
  openWeek();
  const tray = within(
    screen.getByRole("region", {
      name: "Next steps: Ship the small website refresh",
    }),
  );
  // The estimate in the warning colour is the whole cue: no sentence on the card.
  expect(
    tray.queryByText("Over 2 hours. You can keep it or split it further."),
  ).toBeNull();
  expect(
    document.querySelector(
      '.planning-tray-step[data-task-id="copy"] .planning-step-long',
    )?.textContent,
  ).toBe("2h");
  expect(
    document.querySelectorAll(".planning-tray-step .planning-step-long"),
  ).toHaveLength(1);
  expect(
    (
      tray.getByRole("button", {
        name: "Drag step: Write the introduction",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(
    tray.getByRole("button", { name: /^Write the introduction/u }),
  );
  expect(data.editTask).toHaveBeenCalledWith(task);
  expect(
    (
      screen.getByRole("button", {
        name: "Remove from 2026-10-13: Write the introduction",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
});

it("folds Committed to its heading line and keeps the runway line and Next steps", async () => {
  const data = await props();
  // No personal commitment, so the Personal filter leaves none selected.
  data.plan.tasks = data.plan.tasks.map((task) =>
    task.id === "desk" ? { ...task, area: "work" } : task,
  );
  render(<PlanView {...data} />);
  openWeek();
  const toggle = screen.getByRole("button", { name: "Committed" });
  const filter = screen.getByRole("tablist", { name: "Commitment area" });
  // The grid it controls is there whether it is folded or not.
  const grid = () =>
    document.getElementById(toggle.getAttribute("aria-controls")!);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(grid()?.classList.contains("planning-commitment-grid")).toBe(true);
  expect(grid()?.hidden).toBe(false);

  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(grid()?.hidden).toBe(true);
  expect(filter.hidden).toBe(true);
  // The heading line keeps the count and never repeats the selected title: the tray names it.
  expect(toggle.closest("div")!.textContent).toBe(
    "Committed4 outcomes2 commitments have nothing planned in these 7 days",
  );
  expect(
    screen.getByRole("region", {
      name: "Next steps: Ship the small website refresh",
    }),
  ).toBeTruthy();
  // The runway line still selects the next unplanned commitment.
  fireEvent.click(
    screen.getByRole("button", {
      name: "2 commitments have nothing planned in these 7 days",
    }),
  );
  expect(
    screen.getByRole("region", {
      name: "Next steps: Organize the experiment notes",
    }),
  ).toBeTruthy();

  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(grid()?.hidden).toBe(false);
  expect(filter.hidden).toBe(false);
  expect(toggle.closest("div")!.textContent).toBe(
    "Committed4 outcomes2 commitments have nothing planned in these 7 days",
  );
  // Clicking the selected commitment keeps it selected.
  const selected = document.querySelector<HTMLElement>(
    ".planning-outcome-card.is-selected",
  )!;
  fireEvent.click(selected);
  expect(selected.classList.contains("is-selected")).toBe(true);
  // With nothing selected, folded Week says where to choose one.
  fireEvent.click(within(filter).getByRole("tab", { name: "Personal" }));
  expect(
    screen.getByText("Choose an outcome above to arrange its next steps."),
  ).toBeTruthy();
  fireEvent.click(toggle);
  expect(
    screen.getByText("Expand Committed to choose an outcome."),
  ).toBeTruthy();
});

it("remembers Week, its commitment and fold, and this week's review when Plan mounts again", async () => {
  const data = await props();
  const store = viewStore();
  const first = render(
    <PlanView {...data} planView={store.view} onPlanView={store.onPlanView} />,
  );
  // A mount alone stores nothing.
  expect(store.patches).toEqual([]);
  const areas = () =>
    within(screen.getByRole("tablist", { name: "Outcome area" }));
  fireEvent.click(areas().getByRole("tab", { name: "Work" }));
  openWeek();
  fireEvent.click(
    screen.getByRole("button", {
      name: /^Prepare the next research check-in,/u,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Committed" }));
  fireEvent.click(screen.getByRole("button", { name: "Weekly review" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Reviewed: Someday" }));
  const review = { week: "2026-10-12", open: true, lines: [], kept: [] };
  // Each change sends only its own field.
  expect(store.patches).toEqual([
    { area: "work" },
    { tab: "week" },
    { commitment: "research" },
    { committedFolded: true },
    { review },
    { review: { ...review, lines: [4] } },
  ]);
  first.unmount();

  render(
    <PlanView {...data} planView={store.view} onPlanView={store.onPlanView} />,
  );
  expect(store.patches).toHaveLength(6);
  expect(
    screen.getByRole("tab", { name: "Week" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(
    screen.getByRole("region", {
      name: "Next steps: Prepare the next research check-in",
    }),
  ).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Committed" })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  expect(
    screen.getByRole("checkbox", { name: "Reviewed: Someday" }),
  ).toHaveProperty("checked", true);
  // Review's area filter is back as it was left.
  fireEvent.click(screen.getByRole("tab", { name: "Review" }));
  expect(
    areas().getByRole("tab", { name: "Work" }).getAttribute("aria-selected"),
  ).toBe("true");
});

it("closes Add steps when the selected commitment changes on its own, and takes no focus", async () => {
  const data = await props();
  const { rerender } = render(<PlanView {...data} />);
  openWeek();
  fireEvent.click(
    screen.getByRole("button", {
      name: "Add steps to “Ship the small website refresh”",
    }),
  );
  fireEvent.change(screen.getByRole("textbox", { name: "New step" }), {
    target: { value: "Synthetic draft" },
  });
  // Left with a draft, it stays open.
  const tab = screen.getByRole("tab", { name: "Week" });
  tab.focus();
  expect(screen.getByRole("textbox", { name: "New step" })).toBeTruthy();
  // A read shows the commitment re-staged elsewhere: Week selects the first one left.
  rerender(
    <PlanView
      {...data}
      plan={{
        ...data.plan,
        tasks: data.plan.tasks.map((task) =>
          task.id === "release" ? { ...task, stage: "monthly" } : task,
        ),
      }}
    />,
  );
  const tray = screen.getByRole("region", { name: /^Next steps: /u });
  expect(tray.getAttribute("aria-label")).not.toBe(
    "Next steps: Ship the small website refresh",
  );
  expect(within(tray).queryByRole("textbox")).toBeNull();
  expect(
    within(tray).getByRole("button", { name: /^Add steps to “/u }),
  ).toBeTruthy();
  expect(document.activeElement).toBe(tab);
});

it("falls back from a remembered view that no longer fits, writing nothing for it", async () => {
  const data = await props();
  const store = viewStore({
    tab: "week",
    area: "unassigned",
    // Moved out of Committed since.
    commitment: "gone",
    // Last week's checklist was left open.
    review: { week: "2026-10-05", open: true, lines: [1], kept: [] },
    committedFolded: false,
  });
  render(
    <PlanView {...data} planView={store.view} onPlanView={store.onPlanView} />,
  );
  expect(
    screen.getByRole("region", {
      name: "Next steps: Ship the small website refresh",
    }),
  ).toBeTruthy();
  // A new week starts closed.
  expect(screen.queryByRole("region", { name: "Weekly review" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Review" }));
  // No unassigned outcome is on the board, so the filter shows every area.
  expect(screen.queryByRole("tab", { name: "Unassigned" })).toBeNull();
  expect(
    screen.getByRole("tab", { name: "All" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(store.patches).toEqual([{ tab: "review" }]);
  // This week's checklist starts empty.
  fireEvent.click(screen.getByRole("button", { name: "Weekly review" }));
  expect(
    screen.getByRole("checkbox", { name: "Reviewed: Mail to clarify" }),
  ).toHaveProperty("checked", false);
});

it("opens the checklist from the review link even when it was left closed, and stores that", async () => {
  const data = await props();
  const review = { week: "2026-10-12", open: false, lines: [3], kept: [] };
  const store = viewStore({ ...DEFAULT_PLAN_VIEW, review });
  render(
    <PlanView
      {...data}
      reviewing={1}
      planView={store.view}
      onPlanView={store.onPlanView}
    />,
  );
  expect(screen.getByRole("region", { name: "Weekly review" })).toBeTruthy();
  expect(
    screen.getByRole("checkbox", {
      name: "Reviewed: Commitments not planned",
    }),
  ).toHaveProperty("checked", true);
  expect(store.patches).toEqual([{ review: { ...review, open: true } }]);
});

it("opens the checklist again for each new review request, also after it was closed", async () => {
  const data = await props();
  const { rerender } = render(<PlanView {...data} reviewing={0} />);
  const region = () => screen.queryByRole("region", { name: "Weekly review" });
  expect(region()).toBeNull();
  rerender(<PlanView {...data} reviewing={1} />);
  expect(region()).toBeTruthy();
  fireEvent.click(within(region()!).getByRole("button", { name: "Close" }));
  expect(region()).toBeNull();
  // The same request again changes nothing; the next one opens it.
  rerender(<PlanView {...data} reviewing={1} />);
  expect(region()).toBeNull();
  rerender(<PlanView {...data} reviewing={2} />);
  expect(region()).toBeTruthy();
});
