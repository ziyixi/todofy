import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlanView, type PlanViewProps } from "../src/PlanView";
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
    flowTasks: focus.flowTasks,
    currentDate: focus.date,
    language: "en",
    busy: false,
    actions,
    run: vi.fn(),
    editTask: vi.fn(),
    onWeekChange: vi.fn(),
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
  ).toHaveLength(4);
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

it("distinguishes two planning outcomes under the same project and retains local or unavailable queue identities", async () => {
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
  data.days[1]!.taskIds = ["copy", "outline", "local-keep", "missing"];
  data.flowTasks["local-keep"] = {
    title: "Local planning note",
    local: true,
    estimatedMinutes: 15,
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
  expect(card("copy").style.getPropertyValue("--outcome-color")).not.toBe(
    card("outline").style.getPropertyValue("--outcome-color"),
  );
  expect(card("local-keep").textContent).toContain("Local planning note");
  expect(card("missing").textContent).toContain("Task unavailable");
});

it("keeps timed steps readable while preventing their move, and warns rather than rejecting long steps", async () => {
  const data = await props();
  const task = data.plan.tasks.find((task) => task.id === "copy")!;
  task.estimatedMinutes = 120;
  data.timer = {
    taskId: "copy",
    flowDate: data.currentDate,
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
  expect(
    tray.getByText("Over 2 hours. You can keep it or split it further."),
  ).toBeTruthy();
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
  // With nothing selected, folded Week says where to choose one.
  fireEvent.click(
    document.querySelector<HTMLElement>(".planning-outcome-card.is-selected")!,
  );
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
  fireEvent.click(screen.getByRole("checkbox", { name: "Reviewed: Waiting" }));
  const review = { week: "2026-10-12", open: true, lines: [], kept: [] };
  // Each change sends only its own field.
  expect(store.patches).toEqual([
    { area: "work" },
    { tab: "week" },
    { commitment: "research" },
    { committedFolded: true },
    { review },
    { review: { ...review, lines: [2] } },
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
    screen.getByRole("checkbox", { name: "Reviewed: Waiting" }),
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
      reviewing
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
