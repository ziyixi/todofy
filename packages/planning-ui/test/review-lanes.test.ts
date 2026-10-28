import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addDays } from "../src/domain";
import { committedOutcomes } from "../src/planning-outcomes";
import { withStage } from "../src/plan-updates";
import { planVisibility } from "../src/plan-visibility";
import { quickTasks } from "../src/weekly-review";
import {
  boardLanes,
  cardState,
  cardStatus,
  statusLine,
  type LaneId,
} from "../src/review-lanes";
import type { PlanState, PlanningTask } from "../src/model";

// A synthetic Thursday; "now" is its noon.
const TODAY = "2026-10-15";
const on = (days: number) => addDays(TODAY, days);
beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse(`${TODAY}T12:00:00Z`), toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});
const task = (id: string, value: Partial<PlanningTask> = {}): PlanningTask => ({
  id,
  title: `Synthetic ${id}`,
  parentId: "",
  projectId: "synthetic",
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
/** Each lane's task IDs, in their order. */
function laneIds(
  tasks: PlanningTask[],
  laneOrders: PlanState["laneOrders"] = {},
) {
  const lanes = boardLanes({ tasks, dependencies: [], laneOrders }, TODAY);
  return Object.fromEntries(
    Object.entries(lanes).map(([lane, cards]) => [
      lane,
      cards.map((card) => card.id),
    ]),
  ) as Record<LaneId, string[]>;
}

it("surfaces unstarted tasks in Parked once and hides waiting tasks from every lane", () => {
  const tasks = [
    task("staged-start", {
      stage: "committed",
      planningFlags: [],
      deadline: on(5),
      leadDays: 7,
      mustStart: true,
    }),
    task("staged-wait", { stage: "monthly", planningFlags: ["waiting"] }),
    // Only the 7-day date rule made these Week candidates: they have no Week label.
    task("dated-start", {
      stage: "weekly",
      planningFlags: [],
      deadline: on(2),
      leadDays: 3,
      mustStart: true,
    }),
    task("dated-wait", {
      stage: "weekly",
      planningFlags: ["waiting"],
      due: on(2),
    }),
    task("dated", { stage: "weekly", due: on(2) }),
    task("week", { stage: "weekly", explicitStage: "weekly", due: on(2) }),
    task("blocked", { planningFlags: ["blocked"] }),
    task("past", { deadline: on(-1), mustStart: true }),
    // Todofy lists a waiting task past its deadline as must start too; it waits.
    task("past-wait", {
      planningFlags: ["waiting"],
      deadline: on(-2),
      mustStart: true,
    }),
    // A step with its own start window, under a staged outcome.
    task("step", {
      parentId: "staged-start",
      deadline: on(2),
      leadDays: 3,
      mustStart: true,
    }),
    // A waiting step with its outcome's stage is no card of its own in that lane.
    task("step-wait", {
      parentId: "staged-start",
      stage: "committed",
      planningFlags: ["waiting"],
    }),
    // In progress, not yet in the window, or without a lead: on no lane.
    task("active", { planningFlags: ["active"], deadline: on(3), leadDays: 7 }),
    task("later", { deadline: on(30), leadDays: 7 }),
    task("no-lead", { deadline: on(40), missingLead: true }),
  ];
  expect(laneIds(tasks)).toEqual({
    start: [],
    parked: ["past", "dated-start", "step"],
    quarterly: [],
    monthly: [],
    weekly: ["dated", "week"],
    committed: ["staged-start"],
    waiting: [],
  });
  // A ready card keeps its start status: in Parked, or committed work in its own lane.
  expect(
    Object.fromEntries(tasks.map((item) => [item.id, cardState(item, TODAY)])),
  ).toEqual({
    "staged-start": "start",
    "staged-wait": "waiting",
    "dated-start": "start",
    "dated-wait": "waiting",
    dated: undefined,
    week: undefined,
    blocked: "waiting",
    past: "start",
    "past-wait": "waiting",
    step: "start",
    "step-wait": "waiting",
    active: undefined,
    later: undefined,
    "no-lead": undefined,
  });
});

it("orders automatic Parked cards by deadline then priority and excludes waiting tasks", () => {
  const ids = laneIds([
    task("visa", { deadline: on(5), mustStart: true }),
    task("claim", { deadline: on(1), mustStart: true }),
    task("claim-p1", { deadline: on(1), mustStart: true, priority: 4 }),
    task("report", { deadline: on(-2), mustStart: true }),
    task("unknown", { planningFlags: ["waiting"] }),
    task("quote", {
      planningFlags: ["waiting"],
      updatedAt: "2026-10-10T09:00:00Z",
    }),
    task("contract", {
      planningFlags: ["blocked"],
      updatedAt: "2026-10-01T09:00:00Z",
    }),
  ]);
  expect([ids.parked, ids.waiting]).toEqual([
    ["report", "claim-p1", "claim", "visa"],
    [],
  ]);
});

it("keeps manually parked tasks in Parked while excluding a parked task that waits", () => {
  const tasks = [
    task("plain", {
      planningFlags: ["parked"],
      updatedAt: "2026-10-10T09:00:00Z",
    }),
    task("staged", {
      stage: "committed",
      planningFlags: ["parked"],
      updatedAt: "2026-09-01T09:00:00Z",
    }),
    task("waits", {
      planningFlags: ["waiting", "parked"],
      updatedAt: "2026-10-01T09:00:00Z",
    }),
    // A step of the committed outcome, set aside on its own.
    task("step", {
      parentId: "outcome",
      planningFlags: ["parked"],
      deadline: on(-1),
    }),
    task("outcome", { stage: "committed", planningFlags: [] }),
    task("quick", {
      explicitStage: "weekly",
      planningFlags: ["quick"],
      stage: "weekly",
    }),
  ];
  // Longest untouched first, unknown ages last; in no other lane.
  expect(laneIds(tasks)).toEqual({
    start: [],
    waiting: [],
    parked: ["staged", "plain", "step"],
    quarterly: [],
    monthly: [],
    weekly: ["quick"],
    committed: ["outcome"],
  });
});

it("lists the commitments Review's Committed lane shows, none of them parked", () => {
  const tasks = [
    task("kept", { stage: "committed", planningFlags: [] }),
    // In its start window it stays committed, in both lists, with its status.
    task("due", { stage: "committed", deadline: on(1), mustStart: true }),
    task("set-aside", { stage: "committed", planningFlags: ["parked"] }),
    task("waits", { stage: "committed", planningFlags: ["waiting"] }),
    task("week", { stage: "weekly", explicitStage: "weekly" }),
  ];
  const plan = { tasks, dependencies: [], laneOrders: {} };
  expect(
    committedOutcomes({ ...plan, tasks: planVisibility(plan).tasks }),
  ).toEqual(boardLanes(plan, TODAY).committed);
  expect(boardLanes(plan, TODAY).committed.map((item) => item.id)).toEqual([
    "kept",
    "due",
  ]);
  expect(boardLanes(plan, TODAY).parked.map((item) => item.id)).toEqual([
    "set-aside",
  ]);
  expect(
    committedOutcomes({ tasks, laneOrders: {} }).map((item) => item.id),
  ).toEqual(["kept", "due", "waits"]);
});

it("puts newly ready tasks before arranged automatic cards and the manual Parked backlog", () => {
  const tasks = [
    task("claim", { deadline: on(1), mustStart: true }),
    task("report", { deadline: on(-2), mustStart: true }),
    task("visa", { deadline: on(5), mustStart: true }),
    task("quote", {
      planningFlags: ["waiting"],
      updatedAt: "2026-10-10T09:00:00Z",
    }),
    task("contract", {
      planningFlags: ["waiting"],
      updatedAt: "2026-10-01T09:00:00Z",
    }),
    task("idea", {
      planningFlags: ["parked"],
      updatedAt: "2026-10-12T09:00:00Z",
    }),
    task("plan", {
      planningFlags: ["parked"],
      updatedAt: "2026-09-12T09:00:00Z",
    }),
    ...["one", "two", "three"].map((id) =>
      task(id, { stage: "committed", planningFlags: [] }),
    ),
  ];
  expect(
    laneIds(tasks, {
      // A task no longer in the lane is skipped; one never arranged follows the arranged ones.
      committed: ["three", "gone", "one"],
      waiting: ["quote"],
      // Manual cards keep their saved order; a new automatic card comes before old ready cards.
      parked: ["idea", "visa", "plan", "claim", "gone"],
      start: ["claim", "visa"],
    }),
  ).toMatchObject({
    committed: ["three", "one", "two"],
    waiting: [],
    parked: ["report", "visa", "claim", "idea", "plan"],
    start: [],
  });
});

it("surfaces both readiness reasons once without changing a saved stage, dates or flags", () => {
  const item = task("ready", {
    stage: "quarterly",
    explicitStage: "quarterly",
    deadline: on(3),
    due: on(1),
    leadDays: 7,
    mustStart: true,
    planningFlags: ["routine"],
  });
  const plan: PlanState = {
    tasks: [item],
    dependencies: [
      { taskId: item.id, prerequisiteId: "completed", done: true },
    ],
    laneOrders: { quarterly: [item.id] },
    today: TODAY,
    week: "2026-10-12",
    timezone: "America/Los_Angeles",
    weeklyBets: [],
    nextWeekTaskIds: [],
  };
  const before = structuredClone(plan);
  const lanes = boardLanes(plan, TODAY);
  expect(lanes.parked).toEqual([item]);
  expect(lanes.parked[0]).toBe(item);
  expect(
    Object.values(lanes)
      .flat()
      .filter((task) => task.id === item.id),
  ).toHaveLength(1);
  expect(plan).toEqual(before);
  expect(cardState(item, TODAY, [], true)).toBe("start");

  // Picking it up acknowledges either reason with the existing In progress flag.
  const pickedUp = withStage(plan, item.id, "monthly", true);
  expect(boardLanes(pickedUp, TODAY)).toMatchObject({
    parked: [],
    monthly: [pickedUp.tasks[0]],
  });
  expect(pickedUp.tasks[0]).toMatchObject({
    stage: "monthly",
    explicitStage: "monthly",
    planningFlags: ["routine", "active"],
    deadline: item.deadline,
    due: item.due,
    leadDays: item.leadDays,
  });
  expect(pickedUp.dependencies).toBe(plan.dependencies);
  // A fresh read still has the completed dependency; it must not surface again.
  const reloaded = structuredClone(pickedUp);
  expect(boardLanes(reloaded, TODAY).parked).toEqual([]);
  expect(cardState(reloaded.tasks[0]!, TODAY, [], true)).toBeUndefined();
});

it("names completed prerequisites as the reason when no deadline is ready", () => {
  const item = task("ready");
  expect(cardState(item, TODAY, [], true)).toBe("ready");
  expect(cardStatus(item, "ready", TODAY, "en")).toEqual([
    { text: "Prerequisites completed" },
  ]);
  expect(cardStatus(item, "ready", TODAY, "zh")).toEqual([
    { text: "前置任务已完成" },
  ]);
});

it("says each card's one status: how long is left, or how long untouched with the deadline", () => {
  const status = (item: PlanningTask, language: "zh" | "en") =>
    cardStatus(item, cardState(item, TODAY)!, TODAY, language);
  const claim = task("claim", { deadline: on(1), mustStart: true });
  const late = task("late", { deadline: on(-2), mustStart: true });
  const contract = task("contract", {
    planningFlags: ["waiting"],
    deadline: on(7),
    updatedAt: "2026-10-03T09:00:00Z",
  });
  const quote = task("quote", {
    planningFlags: ["blocked"],
    updatedAt: "2026-10-03T09:00:00Z",
  });
  const overdue = task("overdue", {
    planningFlags: ["waiting"],
    deadline: on(-2),
    mustStart: true,
    updatedAt: "2026-10-15T09:00:00Z",
  });
  expect(
    [claim, late, contract, quote, overdue].map((item) => [
      status(item, "zh"),
      status(item, "en"),
    ]),
  ).toEqual([
    [[{ text: "明天截止" }], [{ text: "Deadline tomorrow" }]],
    [
      [{ text: "", danger: "已过 2 天" }],
      [{ text: "", danger: "2 days late" }],
    ],
    [
      [{ text: "12 天未变动" }, { text: "10月22日截止" }],
      [{ text: "No change in 12 days" }, { text: "Deadline Oct 22" }],
    ],
    [[{ text: "12 天未变动" }], [{ text: "No change in 12 days" }]],
    [
      // Past its deadline, the board's one red wording, including in Parked.
      [{ text: "1 天内有变动" }, { text: "", danger: "已过 2 天" }],
      [{ text: "Changed within a day" }, { text: "", danger: "2 days late" }],
    ],
  ]);
  // Shown, and named, as one line.
  expect(statusLine(status(contract, "zh"))).toBe("12 天未变动 · 10月22日截止");
  expect(statusLine(status(overdue, "en"))).toBe(
    "Changed within a day · 2 days late",
  );
  // A wait of unknown age without a deadline says nothing.
  expect(status(task("plain", { planningFlags: ["waiting"] }), "en")).toEqual(
    [],
  );
});

/** Ready tasks appear once, manual parking remains, and waiting hides every stage combination. */
it("hides every waiting task and shows eligible ready or parked tasks at most once", () => {
  const marks = ["waiting", "blocked", "active", "parked"];
  const stages = [
    { stage: "none" as const },
    { stage: "committed" as const, explicitStage: "committed" as const },
    { stage: "monthly" as const, explicitStage: "monthly" as const },
    // The date rule's Week candidate.
    { stage: "weekly" as const, due: on(2) },
  ];
  const outcome = task("outcome", {
    stage: "committed",
    explicitStage: "committed",
  });
  for (let combination = 0; combination < 1 << marks.length; combination++)
    for (const deadline of ["", on(-3), TODAY, on(5), on(40)])
      for (const plan of stages)
        for (const parentId of ["", outcome.id])
          for (const mustStart of [false, true])
            for (const missingLead of [false, true]) {
              const labels = marks.filter((_, bit) => (combination >> bit) & 1);
              // Todofy's must_start never comes with a missing deadline or these labels.
              if (
                mustStart &&
                (!deadline ||
                  labels.some((label) =>
                    ["active", "blocked", "parked"].includes(label),
                  ))
              )
                continue;
              const item = task("grid", {
                ...plan,
                parentId,
                planningFlags: labels,
                deadline,
                mustStart,
                missingLead,
              });
              const lanes = boardLanes(
                { tasks: [outcome, item], dependencies: [], laneOrders: {} },
                TODAY,
              );
              const shown = Object.values(lanes).filter((cards) =>
                cards.includes(item),
              ).length;
              const name = JSON.stringify(item);
              expect(shown, name).toBeLessThanOrEqual(1);
              if (labels.includes("waiting") || labels.includes("blocked")) {
                expect(shown, name).toBe(0);
                continue;
              }
              if (labels.includes("parked")) {
                expect(lanes.parked, name).toContain(item);
                continue;
              }
              if (mustStart) {
                expect(cardState(item, TODAY), name).toBe("start");
                // Committed work keeps its status in Committed: its own card, or a step of its outcome's.
                if (plan.stage === "committed")
                  expect(lanes.committed.includes(item), name).toBe(!parentId);
                else expect(lanes.parked, name).toContain(item);
              }
            }
});

/**
 * The client half of the Quick / Ops gate: Week's Quick tasks are exactly the ones Todofy's
 * quick_visible selects over the same grid (marks, due offsets -2, 0, 2, 3 and 8 as a date, a
 * floating time and fixed-zone times near both local midnights, deadlines none or today, in Los
 * Angeles), so hiding the native filter loses no task.
 */
it("lists as Quick tasks exactly what Todofy's gate reads the hidden Quick / Ops filter to show", () => {
  const timezone = "America/Los_Angeles";
  const marks = ["waiting", "blocked", "active", "parked", "quick"];
  // Each form with its local day; Los Angeles is UTC-7 on these days.
  const forms = (offset: number) =>
    [
      on(offset),
      `${on(offset)}T09:00:00`,
      `${on(offset)}T07:30:00Z`,
      `${on(offset + 1)}T06:30:00Z`,
    ].map((due) => ({ due, day: on(offset) }));
  const dues = [{ due: "", day: "" }, ...[-2, 0, 2, 3, 8].flatMap(forms)];
  const tasks: PlanningTask[] = [];
  const expected: string[] = [];
  for (let combination = 0; combination < 1 << marks.length; combination++)
    for (const { due, day } of dues)
      for (const deadline of ["", TODAY]) {
        const labels = marks.filter((_, bit) => (combination >> bit) & 1);
        const id = `grid-${tasks.length}`;
        tasks.push(task(id, { planningFlags: labels, due, deadline }));
        if (
          labels.includes("quick") &&
          (!due || day <= on(2) || (Boolean(deadline) && deadline <= on(2)))
        )
          expected.push(id);
      }
  expect(
    quickTasks({ tasks, timezone }, TODAY)
      .map((item) => item.id)
      .sort(),
  ).toEqual(expected.sort());
  expect(expected.length).toBeGreaterThan(0);
});
