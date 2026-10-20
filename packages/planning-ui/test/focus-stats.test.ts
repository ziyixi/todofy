import { expect, it } from "vitest";
import { dayTotals, groups, monthStats, weekStats } from "../src/focus-stats";
import type { Area, DayPlan, FocusEntry, FocusTaskInfo } from "../src/model";

let next = 0;
const record = (
  taskId: string,
  date: string,
  minutes: number,
  area: Area,
): FocusEntry => ({
  id: `record-${++next}`,
  taskId,
  date,
  seconds: minutes * 60,
  source: "manual",
  area,
  etag: "1",
});
const day = (
  date: string,
  entries: FocusEntry[] = [],
  done: string[] = [],
  open: string[] = [],
): DayPlan => ({ date, taskIds: open, completedTaskIds: done, entries });
const info = (
  title: string,
  parentId = "",
  parentTitle = "",
  estimatedMinutes?: number,
): FocusTaskInfo => ({
  title,
  parentId,
  parentTitle,
  ...(estimatedMinutes ? { estimatedMinutes } : {}),
  completed: false,
});
const tasks: Record<string, FocusTaskInfo> = {
  draft: info("Draft the outline", "paper", "Finish the paper", 30),
  figures: info("Make the figures", "paper", "Finish the paper", 60),
  walk: info("Plan the weekend walk", "", "", 20),
  photos: info("Book the photo slot", "passport", "Renew the passport", 15),
};

it("totals a day's logged time by the area each record kept", () => {
  expect(
    dayTotals(
      day("2026-10-13", [
        record("draft", "2026-10-13", 30, "work"),
        record("walk", "2026-10-13", 15, "personal"),
        record("photos", "2026-10-13", 5, "unassigned"),
        record("figures", "2026-10-13", 10, "work"),
      ]),
    ),
  ).toEqual({
    total: 60 * 60,
    work: 40 * 60,
    personal: 15 * 60,
    unassigned: 5 * 60,
  });
  expect(dayTotals(day("2026-10-14"))).toEqual({
    total: 0,
    work: 0,
    personal: 0,
    unassigned: 0,
  });
});

it("counts a week's steps done and how long the done steps with an estimate and records took", () => {
  const week = [
    day("2026-10-12", [record("draft", "2026-10-12", 20, "work")]),
    day(
      "2026-10-13",
      [
        record("draft", "2026-10-13", 25, "work"),
        record("figures", "2026-10-13", 50, "work"),
      ],
      // Draft is done; the walk too, with no record; Photos has records but no estimate here.
      ["draft", "walk"],
      ["figures"],
    ),
    day(
      "2026-10-14",
      [record("photos", "2026-10-14", 40, "personal")],
      ["photos"],
    ),
  ];
  const stats = weekStats(week, {
    ...tasks,
    photos: info("Book the photo slot", "passport", "Renew the passport"),
  });
  expect(stats).toMatchObject({
    total: (20 + 25 + 50 + 40) * 60,
    work: (20 + 25 + 50) * 60,
    personal: 40 * 60,
    unassigned: 0,
    stepsDone: 3,
  });
  // Only Draft qualifies: 45 minutes against its 30.
  expect(stats.ratio).toBe(150);
  // Nothing qualifies: no ratio at all.
  expect(weekStats([week[0]!], tasks).ratio).toBeUndefined();
});

it("counts a recurring step's estimate once for each day it was done", () => {
  // A daily 30-minute step that took exactly 30 minutes on two days took 100% of its estimate.
  const week = [
    day("2026-10-12", [record("draft", "2026-10-12", 30, "work")], ["draft"]),
    day("2026-10-13", [record("draft", "2026-10-13", 30, "work")], ["draft"]),
  ];
  expect(weekStats(week, tasks)).toMatchObject({ stepsDone: 2, ratio: 100 });
});

it("counts only a month's own days, never the neighbouring days its calendar shows", () => {
  const days = [
    day("2026-09-30", [record("draft", "2026-09-30", 90, "work")], ["walk"]),
    day("2026-10-01", [record("walk", "2026-10-01", 30, "personal")], ["walk"]),
    day("2026-10-31", [record("draft", "2026-10-31", 10, "work")]),
    day("2026-11-01", [record("draft", "2026-11-01", 45, "work")], ["draft"]),
  ];
  expect(monthStats(days, "2026-10", tasks)).toEqual({
    total: 40 * 60,
    work: 10 * 60,
    personal: 30 * 60,
    unassigned: 0,
    stepsDone: 1,
    ratio: 150,
  });
});

it("groups records by their task's immediate parent, the largest first, in the area of the latest record", () => {
  const days = [
    day("2026-10-12", [
      record("draft", "2026-10-12", 20, "personal"),
      record("walk", "2026-10-12", 30, "personal"),
    ]),
    day("2026-10-13", [
      record("figures", "2026-10-13", 25, "work"),
      record("photos", "2026-10-13", 10, "unassigned"),
      record("unknown", "2026-10-13", 5, "work"),
    ]),
  ];
  expect(groups(days, tasks)).toEqual([
    // Draft and Figures share their parent; its latest record is Work's.
    { id: "paper", title: "Finish the paper", seconds: 45 * 60, area: "work" },
    // A task without a parent is its own group.
    {
      id: "walk",
      title: "Plan the weekend walk",
      seconds: 30 * 60,
      area: "personal",
    },
    {
      id: "passport",
      title: "Renew the passport",
      seconds: 10 * 60,
      area: "unassigned",
    },
    // A task the read does not name has no title to show.
    { id: "unknown", title: "", seconds: 5 * 60, area: "work" },
  ]);
});
