import {
  eachDayOfInterval,
  endOfWeek,
  format,
  parseISO,
  startOfWeek,
} from "date-fns";
import {
  getAllTimeEntries,
  getCompletedTaskIdsInDateRange,
  getEntriesInDateRange,
  getFlowTaskIdsInDateRange,
  getTasksByIds,
} from "@/lib/db/queries/analytics";
import { getSetting } from "@/lib/db/queries/settings";
import { serviceError, serviceOk, type ServiceResult } from "@/lib/server/service-result";
import {
  entryDurationSeconds,
  mapEntrySecondsByTask,
  sumEntryDurationSeconds,
} from "@/lib/utils/time-entries";
import { isQuickTaskPlaceholderId } from "@/lib/utils/quick-task";
import type {
  DailyAnalyticsData,
  WeeklyAnalyticsData,
  WorkPatternStatsData,
} from "../contracts";

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

function normalizeTimeZone(timeZone: string | null): string | undefined {
  if (!timeZone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return timeZone;
  } catch {
    return undefined;
  }
}

function makeTimeZoneFormatters(timeZone?: string) {
  const base = timeZone ? { timeZone } : {};
  return {
    weekday: new Intl.DateTimeFormat("en-US", { ...base, weekday: "short" }),
    hour: new Intl.DateTimeFormat("en-US", {
      ...base,
      hour: "numeric",
      hourCycle: "h23",
    }),
    date: new Intl.DateTimeFormat("en-CA", {
      ...base,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }),
  };
}

function getDatePart(
  date: Date,
  formatter: Intl.DateTimeFormat,
  part: "year" | "month" | "day" | "weekday" | "hour"
): string {
  return formatter.formatToParts(date).find((item) => item.type === part)?.value ?? "";
}

function getZonedHour(
  date: Date,
  formatters: ReturnType<typeof makeTimeZoneFormatters>
) {
  return Number(getDatePart(date, formatters.hour, "hour"));
}

function getZonedDayIdx(
  date: Date,
  formatters: ReturnType<typeof makeTimeZoneFormatters>
) {
  return WEEKDAY_INDEX[getDatePart(date, formatters.weekday, "weekday")] ?? 0;
}

function getZonedDateString(
  date: Date,
  formatters: ReturnType<typeof makeTimeZoneFormatters>
) {
  const year = getDatePart(date, formatters.date, "year");
  const month = getDatePart(date, formatters.date, "month");
  const day = getDatePart(date, formatters.date, "day");
  return `${year}-${month}-${day}`;
}

function forEachMinuteSlice(
  start: Date,
  end: Date,
  visit: (sliceStart: Date, secondsInSlice: number) => void
) {
  let cursorMs = start.getTime();
  const endMs = end.getTime();

  while (cursorMs < endMs) {
    const nextMinuteMs = Math.min(
      Math.floor(cursorMs / 60_000) * 60_000 + 60_000,
      endMs
    );
    visit(new Date(cursorMs), (nextMinuteMs - cursorMs) / 1000);
    cursorMs = nextMinuteMs;
  }
}

function computeDailyAnalytics(date: string, timeZone?: string): DailyAnalyticsData {
  const flowEntries = getFlowTaskIdsInDateRange(date, date);
  const completedEntries = getCompletedTaskIdsInDateRange(date, date);
  const timeEntryRows = getEntriesInDateRange(date, date);
  const capacityStr = getSetting("day_capacity_mins");
  const dayCapacityMins = capacityStr ? parseInt(capacityStr, 10) : 360;
  const formatters = makeTimeZoneFormatters(timeZone);

  const plannedTaskIds = [
    ...new Set([
      ...flowEntries.map((row) => row.taskId),
      ...completedEntries.map((row) => row.taskId),
    ].filter((taskId) => !isQuickTaskPlaceholderId(taskId))),
  ];
  const allTaskIds = [
    ...new Set(
      [...plannedTaskIds, ...timeEntryRows.map((entry) => entry.taskId)].filter(
        (taskId) => !isQuickTaskPlaceholderId(taskId)
      )
    ),
  ];
  const taskMap = new Map(getTasksByIds(allTaskIds).map((task) => [task.id, task]));
  const completedSet = new Set(
    completedEntries
      .map((row) => row.taskId)
      .filter((taskId) => !isQuickTaskPlaceholderId(taskId))
  );

  const secondsByTask = mapEntrySecondsByTask(timeEntryRows);

  const tasks = allTaskIds.map((id) => {
    const task = taskMap.get(id);
    return {
      id,
      title: task?.title ?? "Unknown",
      projectName: task?.projectName ?? null,
      projectColor: task?.projectColor ?? null,
      estimatedMins: task?.estimatedMins ?? null,
      loggedMins: Math.round((secondsByTask[id] ?? 0) / 60),
      completed: completedSet.has(id),
    };
  });

  const totalEstimatedMins = tasks.reduce(
    (sum, task) => sum + (task.estimatedMins ?? 0),
    0
  );
  const totalLoggedMins = Math.round(sumEntryDurationSeconds(timeEntryRows) / 60);

  const hourlyMins = new Array(24).fill(0);
  for (const entry of timeEntryRows) {
    if (!entry.startTime || !entry.durationS) continue;
    const start = new Date(entry.startTime);
    const endTime = entry.endTime
      ? new Date(entry.endTime)
      : new Date(start.getTime() + entry.durationS * 1000);
    forEachMinuteSlice(start, endTime, (sliceStart, secondsInSlice) => {
      const hour = getZonedHour(sliceStart, formatters);
      hourlyMins[hour] += secondsInSlice / 60;
    });
  }

  return {
    date,
    tasksPlanned: plannedTaskIds.length,
    tasksCompleted: completedSet.size,
    totalEstimatedMins,
    totalLoggedMins,
    dayCapacityMins,
    tasks,
    hourlyMins: hourlyMins.map((mins) => Math.round(mins)),
  };
}

function computeWeeklyAnalytics(date: string, timeZone?: string): WeeklyAnalyticsData {
  const targetDate = parseISO(date);
  const weekStart = startOfWeek(targetDate, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(targetDate, { weekStartsOn: 1 });
  const startStr = format(weekStart, "yyyy-MM-dd");
  const endStr = format(weekEnd, "yyyy-MM-dd");
  const formatters = makeTimeZoneFormatters(timeZone);

  const allFlowEntries = getFlowTaskIdsInDateRange(startStr, endStr);
  const allCompletedEntries = getCompletedTaskIdsInDateRange(startStr, endStr);
  const allTimeEntries = getEntriesInDateRange(startStr, endStr);
  const allTaskIds = [
    ...new Set([
      ...allFlowEntries.map((row) => row.taskId),
      ...allCompletedEntries.map((row) => row.taskId),
      ...allTimeEntries.map((entry) => entry.taskId),
    ].filter((taskId) => !isQuickTaskPlaceholderId(taskId))),
  ];
  const taskMap = new Map(getTasksByIds(allTaskIds).map((task) => [task.id, task]));

  const days = eachDayOfInterval({ start: weekStart, end: weekEnd }).map((day) => {
    const dateStr = format(day, "yyyy-MM-dd");
    const planned = new Set([
      ...allFlowEntries.filter((row) => row.flowDate === dateStr).map((row) => row.taskId),
      ...allCompletedEntries
        .filter((row) => row.flowDate === dateStr)
        .map((row) => row.taskId),
    ].filter((taskId) => !isQuickTaskPlaceholderId(taskId)));
    const completed = allCompletedEntries.filter(
      (row) =>
        row.flowDate === dateStr && !isQuickTaskPlaceholderId(row.taskId)
    );
    const loggedSecs = sumEntryDurationSeconds(
      allTimeEntries.filter((entry) => entry.flowDate === dateStr)
    );

    return {
      date: dateStr,
      dayOfWeek: format(day, "EEE"),
      tasksPlanned: planned.size,
      tasksCompleted: completed.length,
      loggedMins: Math.round(loggedSecs / 60),
    };
  });

  const projectMap = new Map<
    string,
    { loggedSecs: number; completed: Set<string>; color: string | null }
  >();
  for (const entry of allTimeEntries) {
    if (isQuickTaskPlaceholderId(entry.taskId)) continue;
    const task = taskMap.get(entry.taskId);
    const project = task?.projectName ?? "No Project";
    const color = task?.projectColor ?? null;
    if (!projectMap.has(project)) {
      projectMap.set(project, { loggedSecs: 0, completed: new Set(), color });
    }
    projectMap.get(project)!.loggedSecs += entryDurationSeconds(entry);
  }
  for (const entry of allCompletedEntries) {
    if (isQuickTaskPlaceholderId(entry.taskId)) continue;
    const task = taskMap.get(entry.taskId);
    const project = task?.projectName ?? "No Project";
    const color = task?.projectColor ?? null;
    if (!projectMap.has(project)) {
      projectMap.set(project, { loggedSecs: 0, completed: new Set(), color });
    }
    projectMap.get(project)!.completed.add(entry.taskId);
  }
  const byProject = Array.from(projectMap.entries())
    .map(([projectName, data]) => ({
      projectName,
      projectColor: data.color,
      loggedMins: Math.round(data.loggedSecs / 60),
      tasksCompleted: data.completed.size,
    }))
    .sort((left, right) => right.loggedMins - left.loggedMins);

  const taskDates = new Map<string, Set<string>>();
  for (const entry of allFlowEntries) {
    if (isQuickTaskPlaceholderId(entry.taskId)) continue;
    if (!taskDates.has(entry.taskId)) taskDates.set(entry.taskId, new Set());
    taskDates.get(entry.taskId)!.add(entry.flowDate);
  }
  const completedTaskIds = new Set(
    allCompletedEntries
      .map((row) => row.taskId)
      .filter((taskId) => !isQuickTaskPlaceholderId(taskId))
  );
  const stuckTasks = Array.from(taskDates.entries())
    .filter(([taskId, dates]) => dates.size >= 2 && !completedTaskIds.has(taskId))
    .map(([taskId, dates]) => {
      const task = taskMap.get(taskId);
      return {
        id: taskId,
        title: task?.title ?? "Unknown",
        daysAppeared: dates.size,
        dates: Array.from(dates).sort(),
      };
    })
    .sort((left, right) => right.daysAppeared - left.daysAppeared);

  const seenTaskIds = new Set<string>();
  const estimationAccuracy = allCompletedEntries
    .filter((row) => {
      if (isQuickTaskPlaceholderId(row.taskId)) return false;
      if (seenTaskIds.has(row.taskId)) return false;
      seenTaskIds.add(row.taskId);
      return true;
    })
    .map((row) => {
      const task = taskMap.get(row.taskId);
      if (!task || task.estimatedMins == null || task.estimatedMins <= 0) return null;
      const loggedSecs = sumEntryDurationSeconds(
        allTimeEntries.filter((entry) => entry.taskId === row.taskId)
      );
      if (loggedSecs === 0) return null;
      return {
        id: row.taskId,
        title: task.title,
        estimatedMins: task.estimatedMins,
        actualMins: Math.round(loggedSecs / 60),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item != null);

  let overallAccuracy: number | null = null;
  if (estimationAccuracy.length > 0) {
    const sum = estimationAccuracy.reduce((acc, item) => {
      const ratio =
        Math.min(item.estimatedMins, item.actualMins) /
        Math.max(item.estimatedMins, item.actualMins);
      return acc + ratio;
    }, 0);
    overallAccuracy = Math.round((sum / estimationAccuracy.length) * 100);
  }

  const heatmap: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const entry of allTimeEntries) {
    if (!entry.startTime || !entry.durationS) continue;
    const start = new Date(entry.startTime);
    const endTime = entry.endTime
      ? new Date(entry.endTime)
      : new Date(start.getTime() + entry.durationS * 1000);
    forEachMinuteSlice(start, endTime, (sliceStart, secondsInSlice) => {
      const dayIdx = getZonedDayIdx(sliceStart, formatters);
      const hour = getZonedHour(sliceStart, formatters);
      heatmap[dayIdx][hour] += secondsInSlice / 60;
    });
  }

  const totalCompleted = new Set(
    allCompletedEntries
      .map((row) => row.taskId)
      .filter((taskId) => !isQuickTaskPlaceholderId(taskId))
  ).size;
  const totalLoggedMins = Math.round(
    sumEntryDurationSeconds(allTimeEntries) / 60
  );
  const activeDays = days.filter((day) => day.tasksPlanned > 0).length;

  return {
    weekStart: startStr,
    weekEnd: endStr,
    days,
    byProject,
    stuckTasks,
    estimationAccuracy,
    heatmap: heatmap.map((row) => row.map((mins) => Math.round(mins))),
    totals: {
      tasksCompleted: totalCompleted,
      totalLoggedMins,
      avgTasksPerDay:
        activeDays > 0 ? Math.round((totalCompleted / activeDays) * 10) / 10 : 0,
      overallAccuracy,
    },
  };
}

function computeWorkPatternStats(timeZone?: string): WorkPatternStatsData {
  const allEntries = getAllTimeEntries();
  const formatters = makeTimeZoneFormatters(timeZone);
  const weekSlotSets = new Map<string, Set<string>>();
  const totalMins: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));

  for (const entry of allEntries) {
    if (!entry.startTime || !entry.durationS) continue;
    const start = new Date(entry.startTime);
    const endTime = entry.endTime
      ? new Date(entry.endTime)
      : new Date(start.getTime() + entry.durationS * 1000);
    forEachMinuteSlice(start, endTime, (sliceStart, secondsInSlice) => {
      const dayIdx = getZonedDayIdx(sliceStart, formatters);
      const hour = getZonedHour(sliceStart, formatters);
      const localDate = getZonedDateString(sliceStart, formatters);
      const weekStart = format(
        startOfWeek(parseISO(localDate), { weekStartsOn: 1 }),
        "yyyy-MM-dd"
      );
      const slotKey = `${dayIdx}-${hour}`;
      if (!weekSlotSets.has(slotKey)) weekSlotSets.set(slotKey, new Set());
      weekSlotSets.get(slotKey)!.add(weekStart);
      totalMins[dayIdx][hour] += secondsInSlice / 60;
    });
  }

  const weekCount: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const [slotKey, weeks] of weekSlotSets) {
    const [dayIdx, hour] = slotKey.split("-").map(Number);
    weekCount[dayIdx][hour] = weeks.size;
  }

  const allWeeks = new Set<string>();
  for (const weeks of weekSlotSets.values()) {
    for (const week of weeks) allWeeks.add(week);
  }

  return {
    weekCount: weekCount.map((row) => row.map((count) => count)),
    totalMins: totalMins.map((row) => row.map((mins) => Math.round(mins))),
    totalWeeks: allWeeks.size,
  };
}

export function getAnalytics(args: {
  type: string | null;
  date: string | null;
  timeZone: string | null;
}): ServiceResult<DailyAnalyticsData | WeeklyAnalyticsData | WorkPatternStatsData> {
  const timeZone = normalizeTimeZone(args.timeZone);

  if (args.type === "stats") {
    return serviceOk(computeWorkPatternStats(timeZone));
  }
  if (!args.type || !args.date) {
    return serviceError("type and date required", 400);
  }
  if (args.type === "daily") {
    return serviceOk(computeDailyAnalytics(args.date, timeZone));
  }
  if (args.type === "weekly") {
    return serviceOk(computeWeeklyAnalytics(args.date, timeZone));
  }
  return serviceError("Invalid type", 400);
}
