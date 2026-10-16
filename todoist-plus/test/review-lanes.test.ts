import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addDays } from "../src/domain";
import {
  boardLanes,
  cardState,
  cardStatus,
  statusLine,
  type LaneId,
} from "../src/review-lanes";
import type { PlanningTask } from "../src/model";

// A synthetic Thursday; "now" is its noon.
const TODAY = "2026-10-15";
const on = (days: number) => addDays(TODAY, days);
beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse(`${TODAY}T12:00:00Z`), toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});
const managedLabels = [
  "office",
  "home",
  "bets",
  "quarter",
  "candiate",
  "focus",
  "committed",
].map((role) => ({ role, id: role, label: role }));
const task = (id: string, value: Partial<PlanningTask> = {}): PlanningTask => ({
  id,
  title: `Synthetic ${id}`,
  parentId: "",
  projectId: "synthetic",
  labels: [],
  area: "work",
  stage: "none",
  bet: false,
  priority: 1,
  deadline: "",
  due: "",
  leadDays: 0,
  etag: id,
  mustStart: false,
  missingLead: false,
  ...value,
});
/** Each lane's task IDs. */
function laneIds(tasks: PlanningTask[]) {
  const lanes = boardLanes({ tasks, managedLabels }, TODAY);
  return Object.fromEntries(
    Object.entries(lanes).map(([lane, cards]) => [
      lane,
      cards.map((card) => card.id),
    ]),
  ) as Record<LaneId, string[]>;
}

it("gives every task at most one lane: its own stage, then Waiting, then Start now, then the date rule", () => {
  const tasks = [
    task("staged-start", {
      stage: "committed",
      labels: ["committed", "lead_1w"],
      deadline: on(5),
      leadDays: 7,
      mustStart: true,
    }),
    task("staged-wait", { stage: "monthly", labels: ["candiate", "waiting"] }),
    // Only the 7-day date rule made these Week candidates: they have no Week label.
    task("dated-start", {
      stage: "weekly",
      labels: ["lead_3d"],
      deadline: on(2),
      leadDays: 3,
      mustStart: true,
    }),
    task("dated-wait", { stage: "weekly", labels: ["waiting"], due: on(2) }),
    task("dated", { stage: "weekly", due: on(2) }),
    task("week", { stage: "weekly", labels: ["focus"], due: on(2) }),
    task("blocked", { labels: ["blocked"] }),
    task("past", { deadline: on(-1), mustStart: true }),
    // Todofy lists a waiting task past its deadline as must start too; it waits.
    task("past-wait", {
      labels: ["waiting"],
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
      labels: ["committed", "waiting"],
    }),
    // In progress, not yet in the window, or without a lead: on no lane.
    task("active", { labels: ["active"], deadline: on(3), leadDays: 7 }),
    task("later", { deadline: on(30), leadDays: 7 }),
    task("no-lead", { deadline: on(40), missingLead: true }),
  ];
  expect(laneIds(tasks)).toEqual({
    start: ["past", "dated-start", "step"],
    quarterly: [],
    monthly: ["staged-wait"],
    weekly: ["dated", "week"],
    committed: ["staged-start"],
    waiting: ["dated-wait", "blocked", "past-wait", "step-wait"],
  });
  // A staged card says it waits or should start; the others say so in their lanes.
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

it("orders Start now by deadline, then priority, and Waiting by the longest untouched", () => {
  const ids = laneIds([
    task("visa", { deadline: on(5), mustStart: true }),
    task("claim", { deadline: on(1), mustStart: true }),
    task("claim-p1", { deadline: on(1), mustStart: true, priority: 4 }),
    task("report", { deadline: on(-2), mustStart: true }),
    task("unknown", { labels: ["waiting"] }),
    task("quote", {
      labels: ["waiting"],
      updatedAt: "2026-10-10T09:00:00Z",
    }),
    task("contract", {
      labels: ["blocked"],
      updatedAt: "2026-10-01T09:00:00Z",
    }),
  ]);
  expect([ids.start, ids.waiting]).toEqual([
    ["report", "claim-p1", "claim", "visa"],
    ["contract", "quote", "unknown"],
  ]);
});

it("says each card's one status: how long is left, or how long untouched with the deadline", () => {
  const status = (item: PlanningTask, language: "zh" | "en") =>
    cardStatus(item, cardState(item, TODAY)!, TODAY, language);
  const claim = task("claim", { deadline: on(1), mustStart: true });
  const late = task("late", { deadline: on(-2), mustStart: true });
  const contract = task("contract", {
    labels: ["waiting"],
    deadline: on(7),
    updatedAt: "2026-10-03T09:00:00Z",
  });
  const quote = task("quote", {
    labels: ["blocked"],
    updatedAt: "2026-10-03T09:00:00Z",
  });
  const overdue = task("overdue", {
    labels: ["waiting"],
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
      [{ text: "", danger: "2 days past" }],
    ],
    [
      [{ text: "12 天未变动" }, { text: "10月22日截止" }],
      [{ text: "Untouched 12 days" }, { text: "Deadline Oct 22" }],
    ],
    [[{ text: "12 天未变动" }], [{ text: "Untouched 12 days" }]],
    [
      [{ text: "1 天内有变动" }, { text: "", danger: "已过截止 2 天" }],
      [
        { text: "Changed within a day" },
        { text: "", danger: "2 days past deadline" },
      ],
    ],
  ]);
  // Shown, and named, as one line.
  expect(statusLine(status(contract, "zh"))).toBe("12 天未变动 · 10月22日截止");
  expect(statusLine(status(overdue, "en"))).toBe(
    "Changed within a day · 2 days past deadline",
  );
  // A wait of unknown age without a deadline says nothing.
  expect(status(task("plain", { labels: ["waiting"] }), "en")).toEqual([]);
});

/**
 * The client half of the filter consistency gate (Todofy's tests/unit/test_plus.py checks the
 * server half). From the API's fields alone, every task a replaced filter shows is on the board:
 * one with a `waiting` or `blocked` label in Waiting or in its own stage lane saying it waits; one
 * Todofy marks must start in Start now or in its own stage lane saying it should start; an
 * `active` one may stay off the board.
 */
it("shows every task the API marks for a replaced deadline or waiting filter on the board", () => {
  const marks = ["waiting", "blocked", "active", "parked"];
  const stages = [
    { stage: "none" as const, labels: [] },
    { stage: "committed" as const, labels: ["committed"] },
    // The date rule's Week candidate.
    { stage: "weekly" as const, labels: [], due: on(2) },
  ];
  for (let combination = 0; combination < 1 << marks.length; combination++)
    for (const deadline of ["", on(-3), TODAY, on(5), on(40)])
      for (const plan of stages)
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
              labels: [...plan.labels, ...labels],
              deadline,
              mustStart,
              missingLead,
            });
            const lanes = boardLanes({ tasks: [item], managedLabels }, TODAY);
            const shown = Object.values(lanes).filter((cards) =>
              cards.includes(item),
            ).length;
            const name = JSON.stringify(item);
            expect(shown, name).toBeLessThanOrEqual(1);
            const waits =
              labels.includes("waiting") || labels.includes("blocked");
            if (waits || mustStart) {
              expect(shown, name).toBe(1);
              expect(cardState(item, TODAY), name).toBe(
                waits ? "waiting" : "start",
              );
            }
          }
});
