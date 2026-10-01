import { describe, it, expect, beforeEach } from "vitest";
import { createTimeEntry } from "@/lib/db/queries/entries";
import { addCompletedFlowTask, setFlowTaskIds } from "@/lib/db/queries/flows";
import { setSetting } from "@/lib/db/queries/settings";
import { upsertTasks } from "@/lib/db/queries/tasks";
import type { Task } from "@/lib/types/task";
import { buildMiscTaskId, buildMiscTaskTitle } from "@/lib/utils/misc-task";

/**
 * Integration tests for the analytics computation logic.
 * We import the route handler module and invoke it directly with mock Requests,
 * testing the full pipeline: DB queries → analytics computation → JSON response.
 */

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? "t1",
    todoistId: null,
    title: "Test Task",
    description: null,
    projectName: "Work",
    projectColor: "#ff0000",
    priority: 1,
    labels: [],
    estimatedMins: 30,
    isCompleted: false,
    completedAt: null,
    dueDate: null,
    createdAt: new Date().toISOString(),
    deletedAt: null,
    ...overrides,
  };
}

function seedDay(date: string) {
  upsertTasks([
    makeTask({ id: "t1", title: "Design", estimatedMins: 30 }),
    makeTask({ id: "t2", title: "Code", estimatedMins: 60 }),
  ]);
  setFlowTaskIds(date, ["t1", "t2"]);
  addCompletedFlowTask(date, "t1");
  setSetting("day_capacity_mins", "360");

  createTimeEntry({
    id: "e1",
    taskId: "t1",
    flowDate: date,
    startTime: `${date}T09:00:00.000Z`,
    endTime: `${date}T09:25:00.000Z`,
    durationS: 1500,
    source: "timer",
  });
  createTimeEntry({
    id: "e2",
    taskId: "t2",
    flowDate: date,
    startTime: `${date}T10:00:00.000Z`,
    endTime: `${date}T10:45:00.000Z`,
    durationS: 2700,
    source: "manual",
  });
}

// We dynamically import the GET handler so each test gets the fresh DB from setup
async function callAnalytics(params: string) {
  const mod = await import("@/app/api/analytics/route");
  const url = `http://localhost:3000/api/analytics?${params}`;
  const request = new Request(url);
  const response = await mod.GET(request);
  return response.json();
}

function getHourInTimeZone(iso: string, timeZone: string): number {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      hourCycle: "h23",
    }).format(new Date(iso))
  );
}

function getDayIndexInTimeZone(iso: string, timeZone: string): number {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(new Date(iso));
  const index: Record<string, number> = {
    Mon: 0,
    Tue: 1,
    Wed: 2,
    Thu: 3,
    Fri: 4,
    Sat: 5,
    Sun: 6,
  };
  return index[weekday] ?? 0;
}

describe("GET /api/analytics — daily", () => {
  beforeEach(() => {
    seedDay("2026-04-13");
  });

  it("returns correct task counts", async () => {
    const data = await callAnalytics("type=daily&date=2026-04-13");
    expect(data.tasksPlanned).toBe(2);
    expect(data.tasksCompleted).toBe(1);
  });

  it("returns correct time totals", async () => {
    const data = await callAnalytics("type=daily&date=2026-04-13");
    // 1500s + 2700s = 4200s = 70min
    expect(data.totalLoggedMins).toBe(70);
    // est: 30 + 60 = 90
    expect(data.totalEstimatedMins).toBe(90);
  });

  it("returns capacity", async () => {
    const data = await callAnalytics("type=daily&date=2026-04-13");
    expect(data.dayCapacityMins).toBe(360);
  });

  it("returns per-task breakdown", async () => {
    const data = await callAnalytics("type=daily&date=2026-04-13");
    expect(data.tasks).toHaveLength(2);
    const design = data.tasks.find((t: { id: string }) => t.id === "t1");
    expect(design.completed).toBe(true);
    expect(design.loggedMins).toBe(25);
  });

  it("returns hourlyMins array", async () => {
    const data = await callAnalytics("type=daily&date=2026-04-13");
    expect(data.hourlyMins).toHaveLength(24);
    // Analytics uses local time — compute expected local hours from UTC timestamps
    const localHour9 = new Date("2026-04-13T09:00:00.000Z").getHours();
    const localHour10 = new Date("2026-04-13T10:00:00.000Z").getHours();
    expect(data.hourlyMins[localHour9]).toBeGreaterThan(0);
    expect(data.hourlyMins[localHour10]).toBeGreaterThan(0);
  });

  it("returns empty for a date with no data", async () => {
    const data = await callAnalytics("type=daily&date=2026-01-01");
    expect(data.tasksPlanned).toBe(0);
    expect(data.totalLoggedMins).toBe(0);
    expect(data.tasks).toHaveLength(0);
  });

  it("uses the requested timezone for hourly bucketing", async () => {
    upsertTasks([makeTask({ id: "tz-daily", title: "Timezone Daily" })]);
    setFlowTaskIds("2026-04-12", ["tz-daily"]);
    createTimeEntry({
      id: "tz-daily-entry",
      taskId: "tz-daily",
      flowDate: "2026-04-12",
      startTime: "2026-04-13T00:30:00.000Z",
      endTime: "2026-04-13T01:00:00.000Z",
      durationS: 1800,
      source: "timer",
    });

    const timeZone = "America/Los_Angeles";
    const data = await callAnalytics(
      `type=daily&date=2026-04-12&tz=${encodeURIComponent(timeZone)}`
    );
    const hour = getHourInTimeZone("2026-04-13T00:30:00.000Z", timeZone);
    expect(data.hourlyMins[hour]).toBe(30);
  });

  it("falls back to the default formatter when the timezone is invalid", async () => {
    const baseline = await callAnalytics("type=daily&date=2026-04-13");
    const invalid = await callAnalytics("type=daily&date=2026-04-13&tz=Invalid%2FZone");
    expect(invalid.hourlyMins).toEqual(baseline.hourlyMins);
  });

  it("splits minutes across hour boundaries", async () => {
    upsertTasks([makeTask({ id: "hour-split-task", title: "Hour Split" })]);
    setFlowTaskIds("2026-04-13", ["hour-split-task"]);
    createTimeEntry({
      id: "hour-split-entry",
      taskId: "hour-split-task",
      flowDate: "2026-04-13",
      startTime: "2026-04-13T00:59:00.000Z",
      endTime: "2026-04-13T01:01:00.000Z",
      durationS: 120,
      source: "timer",
    });

    const data = await callAnalytics("type=daily&date=2026-04-13&tz=UTC");
    expect(data.hourlyMins[0]).toBe(1);
    expect(data.hourlyMins[1]).toBe(1);
  });

  it("includes misc-only time in daily review without inflating planned task counts", async () => {
    createTimeEntry({
      id: "misc-daily-entry",
      taskId: buildMiscTaskId("2026-04-13"),
      flowDate: "2026-04-13",
      startTime: "2026-04-13T11:00:00.000Z",
      endTime: "2026-04-13T11:20:00.000Z",
      durationS: 1200,
      source: "timer",
    });

    const data = await callAnalytics("type=daily&date=2026-04-13");
    expect(data.tasksPlanned).toBe(2);
    expect(data.totalLoggedMins).toBe(90);
    expect(
      data.tasks.find((task: { id: string }) => task.id === buildMiscTaskId("2026-04-13"))
    ).toMatchObject({
      title: buildMiscTaskTitle("2026-04-13"),
      projectName: "Misc",
      loggedMins: 20,
      completed: false,
    });
  });
});

describe("GET /api/analytics — weekly", () => {
  beforeEach(() => {
    // 2026-04-13 is a Monday
    seedDay("2026-04-13");
    // Add another day in the same week
    upsertTasks([makeTask({ id: "t3", title: "Review", estimatedMins: 15 })]);
    setFlowTaskIds("2026-04-14", ["t3"]);
    addCompletedFlowTask("2026-04-14", "t3");
    createTimeEntry({
      id: "e3",
      taskId: "t3",
      flowDate: "2026-04-14",
      startTime: "2026-04-14T14:00:00.000Z",
      endTime: "2026-04-14T14:20:00.000Z",
      durationS: 1200,
      source: "timer",
    });
  });

  it("returns 7 days", async () => {
    const data = await callAnalytics("type=weekly&date=2026-04-13");
    expect(data.days).toHaveLength(7);
    expect(data.days[0].dayOfWeek).toBe("Mon");
    expect(data.days[6].dayOfWeek).toBe("Sun");
  });

  it("computes weekly totals", async () => {
    const data = await callAnalytics("type=weekly&date=2026-04-13");
    // t1 + t3 completed (t2 not completed)
    expect(data.totals.tasksCompleted).toBe(2);
    // 1500 + 2700 + 1200 = 5400s = 90min
    expect(data.totals.totalLoggedMins).toBe(90);
  });

  it("returns byProject breakdown", async () => {
    const data = await callAnalytics("type=weekly&date=2026-04-13");
    expect(data.byProject.length).toBeGreaterThanOrEqual(1);
    const work = data.byProject.find(
      (p: { projectName: string }) => p.projectName === "Work"
    );
    expect(work).toBeDefined();
    expect(work.loggedMins).toBe(90);
  });

  it("returns heatmap as 7x24 grid", async () => {
    const data = await callAnalytics("type=weekly&date=2026-04-13");
    expect(data.heatmap).toHaveLength(7);
    expect(data.heatmap[0]).toHaveLength(24); // Monday
    // Analytics uses local time — compute expected local hour from UTC timestamp
    const localHour9 = new Date("2026-04-13T09:00:00.000Z").getHours();
    expect(data.heatmap[0][localHour9]).toBeGreaterThan(0);
  });

  it("uses the requested timezone for weekly heatmap bucketing", async () => {
    upsertTasks([makeTask({ id: "tz-weekly", title: "Timezone Weekly" })]);
    setFlowTaskIds("2026-04-12", ["tz-weekly"]);
    createTimeEntry({
      id: "tz-weekly-entry",
      taskId: "tz-weekly",
      flowDate: "2026-04-12",
      startTime: "2026-04-13T00:30:00.000Z",
      endTime: "2026-04-13T01:00:00.000Z",
      durationS: 1800,
      source: "timer",
    });

    const timeZone = "America/Los_Angeles";
    const data = await callAnalytics(
      `type=weekly&date=2026-04-12&tz=${encodeURIComponent(timeZone)}`
    );
    const dayIdx = getDayIndexInTimeZone("2026-04-13T00:30:00.000Z", timeZone);
    const hour = getHourInTimeZone("2026-04-13T00:30:00.000Z", timeZone);
    expect(data.heatmap[dayIdx][hour]).toBeGreaterThan(0);
  });

  it("detects estimation accuracy", async () => {
    const data = await callAnalytics("type=weekly&date=2026-04-13");
    // t1 completed with est=30, actual=25. t3 completed with est=15, actual=20
    expect(data.estimationAccuracy.length).toBeGreaterThanOrEqual(1);
  });

  it("includes misc-only time in weekly review project breakdown", async () => {
    createTimeEntry({
      id: "misc-weekly-entry",
      taskId: buildMiscTaskId("2026-04-15"),
      flowDate: "2026-04-15",
      startTime: "2026-04-15T15:00:00.000Z",
      endTime: "2026-04-15T15:30:00.000Z",
      durationS: 1800,
      source: "timer",
    });

    const data = await callAnalytics("type=weekly&date=2026-04-13");
    const miscProject = data.byProject.find(
      (project: { projectName: string }) => project.projectName === "Misc"
    );
    expect(miscProject).toMatchObject({
      projectName: "Misc",
      loggedMins: 30,
      tasksCompleted: 0,
    });
    expect(data.totals.totalLoggedMins).toBe(120);
  });
});

describe("GET /api/analytics — stats", () => {
  beforeEach(() => {
    seedDay("2026-04-13");
  });

  it("returns weekCount and totalMins grids", async () => {
    const data = await callAnalytics("type=stats");
    expect(data.weekCount).toHaveLength(7);
    expect(data.totalMins).toHaveLength(7);
    expect(data.weekCount[0]).toHaveLength(24);
    expect(data.totalWeeks).toBeGreaterThanOrEqual(1);
  });

  it("counts work in correct day/hour slots", async () => {
    const data = await callAnalytics("type=stats");
    // Analytics uses local time — compute expected local day/hour from UTC timestamps
    const d = new Date("2026-04-13T09:00:00.000Z");
    const localDay = (d.getDay() + 6) % 7; // convert Sun=0 to Mon=0 indexing
    const localHour9 = d.getHours();
    const localHour10 = new Date("2026-04-13T10:00:00.000Z").getHours();
    expect(data.weekCount[localDay][localHour9]).toBe(1);
    expect(data.weekCount[localDay][localHour10]).toBe(1);
    expect(data.totalMins[localDay][localHour9]).toBeGreaterThan(0);
  });

  it("uses the requested timezone for stats day and hour grouping", async () => {
    createTimeEntry({
      id: "tz-stats-entry",
      taskId: "t1",
      flowDate: "2026-04-12",
      startTime: "2026-04-13T00:30:00.000Z",
      endTime: "2026-04-13T01:00:00.000Z",
      durationS: 1800,
      source: "timer",
    });

    const timeZone = "America/Los_Angeles";
    const data = await callAnalytics(
      `type=stats&tz=${encodeURIComponent(timeZone)}`
    );
    const dayIdx = getDayIndexInTimeZone("2026-04-13T00:30:00.000Z", timeZone);
    const hour = getHourInTimeZone("2026-04-13T00:30:00.000Z", timeZone);
    expect(data.weekCount[dayIdx][hour]).toBeGreaterThan(0);
    expect(data.totalMins[dayIdx][hour]).toBeGreaterThan(0);
  });

  it("splits work-pattern minutes across day boundaries", async () => {
    createTimeEntry({
      id: "stats-midnight-entry",
      taskId: "t1",
      flowDate: "2026-04-13",
      startTime: "2026-04-19T23:59:00.000Z",
      endTime: "2026-04-20T00:01:00.000Z",
      durationS: 120,
      source: "timer",
    });

    const data = await callAnalytics("type=stats&tz=UTC");
    expect(data.weekCount[6][23]).toBeGreaterThan(0);
    expect(data.weekCount[0][0]).toBeGreaterThan(0);
    expect(data.totalMins[6][23]).toBe(1);
    expect(data.totalMins[0][0]).toBe(1);
  });
});

describe("GET /api/analytics — errors", () => {
  it("returns 400 for missing params", async () => {
    const mod = await import("@/app/api/analytics/route");
    const response = await mod.GET(new Request("http://localhost:3000/api/analytics"));
    expect(response.status).toBe(400);
  });

  it("returns 400 for invalid type", async () => {
    const mod = await import("@/app/api/analytics/route");
    const response = await mod.GET(
      new Request("http://localhost:3000/api/analytics?type=invalid&date=2026-04-13")
    );
    expect(response.status).toBe(400);
  });
});
