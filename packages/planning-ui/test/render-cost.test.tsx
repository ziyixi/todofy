import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { unplannedDue } from "../src/deadlines";
import { effectiveArea, taskAncestors } from "../src/domain";
import {
  outcomeArea,
  outcomeForTask,
  outcomeSteps,
  planningOutcomes,
} from "../src/planning-outcomes";
import { boardLanes } from "../src/review-lanes";
import { planVisibility } from "../src/plan-visibility";
import {
  oldestUntouched,
  SOMEDAY_LABELS,
  unscheduledCommitments,
  WAITING_LABELS,
  withoutLead,
} from "../src/weekly-review";
import { createPrototype } from "./fixture";
import type { PlanState, PlanningTask } from "../src/model";

const planViewRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("@ziyixi/planning-ui/PlanView", async (original) => {
  const actual = await original<typeof import("../src/PlanView")>();
  return {
    ...actual,
    PlanView: (props: Parameters<typeof actual.PlanView>[0]) => {
      planViewRenders.count++;
      return actual.PlanView(props);
    },
  };
});
const focusBlockRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("@ziyixi/planning-ui/FocusBlock", async (original) => {
  const actual = await original<typeof import("../src/FocusBlock")>();
  return {
    ...actual,
    FocusBlock: (props: Parameters<typeof actual.FocusBlock>[0]) => {
      focusBlockRenders.count++;
      return actual.FocusBlock(props);
    },
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** Synthetic outcomes with steps, plus unplanned tasks; some areas are only inherited. */
function dataset(total: number): PlanningTask[] {
  const base = {
    projectId: "synthetic",
    priority: 1,
    deadline: "",
    due: "",
    leadDays: 0,
    etag: "1",
    mustStart: false,
    missingLead: false,
  };
  const tasks: PlanningTask[] = [];
  for (const [stage, count] of [
    ["quarterly", 8],
    ["monthly", 8],
    ["weekly", 10],
    ["committed", 8],
  ] as const)
    for (let n = 0; n < count; n++) {
      const id = `${stage}-${n}`;
      tasks.push({
        ...base,
        id,
        title: id,
        parentId: "",
        area: n % 3 === 2 ? "unassigned" : n % 2 ? "personal" : "work",
        stage,
      });
      for (let step = 0; step < 4; step++)
        tasks.push({
          ...base,
          id: `${id}-step-${step}`,
          title: "step",
          parentId: id,
          area: "unassigned",
          stage: "none",
        });
    }
  for (let n = 0; tasks.length < total; n++)
    tasks.push({
      ...base,
      id: `other-${n}`,
      title: "other",
      parentId: n % 4 === 3 ? `other-${n - 1}` : "",
      area: (["unassigned", "work", "personal"] as const)[n % 3]!,
      stage: "none",
    });
  return tasks;
}
/** Counts element reads of a task list, independent of machine speed. */
function counted(tasks: PlanningTask[]) {
  const reads = { count: 0 };
  const list = new Proxy(tasks, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/u.test(key)) reads.count++;
      return Reflect.get(target, key, receiver);
    },
  });
  return { list, reads };
}
/** Every lane arranged in full: Todofy's 100 IDs each, from the plan's own tasks. */
const laneOrders = Object.fromEntries(
  [
    "start",
    "waiting",
    "parked",
    "quarterly",
    "monthly",
    "weekly",
    "committed",
  ].map((lane, index) => [
    lane,
    Array.from({ length: 100 }, (_, n) => `other-${index * 100 + n}`),
  ]),
);
/**
 * What one Plan render derives from the tasks: the Review board's lanes (Start now, Waiting and
 * Parked too, each in a stored order) and cards, Week cards, Week's runway line and the weekly
 * review's lines; and Focus's quiet deadline line. The Bets are text and read no task.
 */
function planRender(tasks: PlanningTask[]) {
  const outcomes = planningOutcomes(tasks);
  boardLanes({ tasks, dependencies: [], laneOrders }, "2026-10-13");
  unplannedDue(tasks, [], "2026-10-13");
  tasks.some((task) => effectiveArea(task, tasks) === "unassigned");
  for (const outcome of outcomes) {
    outcomeSteps(outcome, tasks);
    outcomeArea(outcome, tasks, "en");
  }
  for (const outcome of outcomes.filter((task) => task.stage === "committed"))
    for (const step of outcomeSteps(outcome, tasks))
      outcomeForTask(step, tasks);
  tasks.filter(
    (task) =>
      effectiveArea(task, tasks) === "work" &&
      taskAncestors(task, tasks).length >= 0,
  );
  const plan = { tasks, laneOrders } as unknown as PlanState;
  oldestUntouched(tasks, WAITING_LABELS);
  oldestUntouched(tasks, SOMEDAY_LABELS);
  withoutLead(tasks);
  unscheduledCommitments(plan, []);
}

it("derives a 2,000-task plan in linear work and reuses its indexes on the next render", () => {
  const { list, reads } = counted(dataset(2_000));
  planRender(list);
  // Rebuilding a lookup per task (the earlier code) needed millions of reads here.
  expect(reads.count).toBeLessThan(20 * list.length);
  const first = reads.count;
  reads.count = 0;
  planRender(list);
  expect(reads.count).toBeLessThan(first);
});

it("filters a 2,000-task Plan once per complete snapshot and reuses its visibility on rerender", () => {
  const tasks = dataset(2_000);
  tasks[0] = { ...tasks[0]!, planningFlags: ["waiting"] };
  const { list, reads } = counted(tasks);
  const plan = { tasks: list, dependencies: [], laneOrders };
  const visible = planVisibility(plan);
  expect(visible.hidden.has(tasks[0]!.id)).toBe(true);
  expect(visible.hidden.has(tasks[1]!.id)).toBe(true);
  expect(reads.count).toBeLessThan(4 * tasks.length);
  reads.count = 0;
  expect(planVisibility(plan)).toBe(visible);
  expect(reads.count).toBe(0);
});

it("ticks a running timer without re-rendering the planning board", async () => {
  const actions = createPrototype();
  const props = {
    actions,
    language: "en" as const,
    onOpenTask: () => {},
    onSettings: () => {},
  };
  const mounted = render(<App {...props} view="focus" />);
  const start = await screen.findByRole("button", {
    name: "Start: Write the introduction",
  });
  vi.useFakeTimers({ now: Date.parse("2026-10-13T12:00:00Z") });
  await act(async () => {
    fireEvent.click(start);
  });
  mounted.rerender(<App {...props} view="plan" />);
  const clock = document.querySelector(".plus-timer-bar output")!;
  expect(clock.textContent).toBe("00:00");
  const before = planViewRenders.count;
  act(() => {
    vi.advanceTimersByTime(3_000);
  });
  expect(clock.textContent).toBe("00:03");
  expect(planViewRenders.count).toBe(before);
});

it("ticks a running session's logged time on its Focus card without re-rendering the cards", async () => {
  const actions = createPrototype();
  render(
    <App
      actions={actions}
      language="en"
      onOpenTask={() => {}}
      onSettings={() => {}}
      view="focus"
    />,
  );
  const start = await screen.findByRole("button", {
    name: "Start: Write the introduction",
  });
  vi.useFakeTimers({ now: Date.parse("2026-10-13T12:00:00Z") });
  await act(async () => {
    fireEvent.click(start);
  });
  const logged = screen.getByRole("button", {
    name: "00:00 logged (Write the introduction)",
  });
  const before = focusBlockRenders.count;
  // The cards are counted: Start re-rendered them once.
  expect(before).toBeGreaterThan(0);
  act(() => {
    vi.advanceTimersByTime(3_000);
  });
  expect(logged.textContent).toMatch(/^00:03 logged/u);
  expect(focusBlockRenders.count).toBe(before);
});
