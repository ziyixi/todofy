import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PlanView, type PlanViewProps } from "../src/PlanView";
import { createPrototype } from "../design/fixture";

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
    onLabels: vi.fn(),
  };
}
function openWeek() {
  fireEvent.click(screen.getByRole("tab", { name: /^Week$/u }));
}

it("opens Review with four real stages and keeps a Bet-only task outside the commitment count", async () => {
  const data = await props();
  const template = data.plan.tasks[0]!;
  data.plan.tasks.push(
    {
      ...template,
      id: "bet-only",
      title: "Independent old bet",
      stage: "none",
      bet: true,
      parentId: "",
    },
    {
      ...template,
      id: "quarter-outcome",
      title: "Explore the next direction",
      stage: "quarterly",
      bet: false,
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
  expect(screen.queryByText("Independent old bet")).toBeNull();
  expect(screen.getByText("3/5 work · 1/3 personal")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Make this a bet/u })).toBeNull();
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

it("shows an actionable Quarter mapping gap and does not mutate labels automatically", async () => {
  const data = await props();
  data.plan.managedLabels = data.plan.managedLabels.filter(
    (label) => label.role !== "quarter",
  );
  const update = vi.spyOn(data.actions, "updateTask");
  render(<PlanView {...data} />);
  const quarter = within(screen.getByRole("region", { name: "Quarter" }));
  expect(quarter.getByText("Choose a label for this column")).toBeTruthy();
  fireEvent.click(quarter.getByRole("button", { name: "Configure labels" }));
  expect(data.onLabels).toHaveBeenCalledOnce();
  expect(update).not.toHaveBeenCalled();
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
