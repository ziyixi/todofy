/** Bounded GTD reporting. Activity is historical; classification and estimates use current task properties. */
import { create } from "@ziyixi/proto/protobuf";
import {
  GtdReportSchema,
  GtdReportDaySchema,
  GtdTaskProgressSchema,
} from "@ziyixi/proto/tasks/ui/v1/gtd_pb";
import type { GetGtdReportRequest } from "@ziyixi/proto/tasks/ui/v1/tasks_ui_service_pb";
import {
  addDays,
  daysBetween,
  localDate,
  zonedInstant,
} from "@ziyixi/task-dates";
import { checkedArea, checkedDay } from "./focus.ts";
import { invalid, storage } from "./errors.ts";
import { planningWeekId, planningWeekStart } from "./planning.ts";

export const REPORT_TASKS = 100;
const routine = (
  alias: string,
) => `(EXISTS(SELECT 1 FROM json_each(${alias}.planning_flags) WHERE value='routine')
  OR (${alias}.kind='step' AND EXISTS(SELECT 1 FROM tasks routine_parent WHERE routine_parent.id=${alias}.parent_id
    AND EXISTS(SELECT 1 FROM json_each(routine_parent.planning_flags) WHERE value='routine'))))`;
/** Match planning-ui's nearest assigned ancestor; each step of the walk is a task primary-key lookup. */
const effectiveArea = `CASE WHEN t.area<>'unassigned' THEN t.area ELSE coalesce((
  WITH RECURSIVE area_ancestors(id,parent_id,area,depth) AS (
    SELECT id,parent_id,area,1 FROM tasks WHERE id=t.parent_id
    UNION ALL SELECT p.id,p.parent_id,p.area,a.depth+1 FROM area_ancestors a JOIN tasks p ON p.id=a.parent_id
      WHERE a.area='unassigned' AND a.depth<32)
  SELECT area FROM area_ancestors WHERE area<>'unassigned' ORDER BY depth LIMIT 1),'unassigned') END`;
const taskArea = `(?7='' OR (${effectiveArea})=?7)`;
const recordArea = `(?7='' OR f.area=?7)`;

/**
 * All queries seek the requested dates/weeks. Removed daily rows and weekly commitments retain first membership;
 * each planned task counts once across the selected period. Completion occurrences establish achievement. A week
 * belongs to the period its Sunday falls in, so a month's commitments are judged through its last week's Saturday
 * and its first partial week belongs to the month before.
 */
const planned = `planned AS (
  SELECT DISTINCT m.task_id FROM gtd_week_commitments m JOIN tasks t ON t.id=m.task_id
    WHERE m.week_start BETWEEN ?5 AND ?6 AND t.kind='task' AND NOT ${routine("t")} AND ${taskArea}
  UNION SELECT DISTINCT s.task_id FROM day_steps s JOIN tasks t ON t.id=s.task_id
    WHERE s.day BETWEEN ?3 AND ?4 AND t.kind='step' AND NOT ${routine("t")} AND ${taskArea})`;
const completed = `completed AS (
  SELECT c.task_id,count(*) AS completion_count,max(c.completed_at) AS last_completed_at
  FROM completions c JOIN tasks t ON t.id=c.task_id
  WHERE c.completed_at>=?1 AND c.completed_at<?2 AND ${taskArea} GROUP BY c.task_id)`;
const timed = `timed AS (
  SELECT f.task_id,sum(f.seconds) AS recorded_seconds FROM focus_entries f
  WHERE f.day BETWEEN ?3 AND ?4 AND f.deleted_at IS NULL AND ${recordArea} GROUP BY f.task_id)`;

interface DayCounts {
  day: string;
  task_count: number;
  step_count: number;
  routine_count: number;
  unclassified_count: number;
}
interface DayTime {
  day: string;
  seconds: number;
  work_seconds: number;
  personal_seconds: number;
  unassigned_seconds: number;
  routine_seconds: number;
}
interface TaskProgressRow {
  id: string;
  title: string;
  kind: string;
  parent_id: string;
  parent_title: string;
  parent_duration_minutes: number;
  area: string;
  routine: number;
  duration_minutes: number;
  completion_count: number;
  last_completed_at: number | null;
  recorded_seconds: number;
  planned: number;
  completed: number;
  step_count: number;
  completed_step_count: number;
}

export async function getGtdReport(
  db: D1Database,
  input: GetGtdReportRequest,
  zone: string,
  now: number,
) {
  if (input.name !== "gtdReport") invalid("The report is named gtdReport");
  const defaultWeek =
    !input.startDay && !input.endDay
      ? planningWeekStart(localDate(now, zone))
      : "";
  const start = defaultWeek || checkedDay(input.startDay, "start_day");
  const end = defaultWeek
    ? addDays(defaultWeek, 6)
    : checkedDay(input.endDay, "end_day");
  const span = daysBetween(start, end);
  if (span < 0 || span > 30) invalid("Read 1 to 31 days");
  const area = checkedArea(input.area);
  const days = Array.from({ length: span + 1 }, (_, index) =>
    addDays(start, index),
  );
  // Each midnight is resolved in the account's zone, including 23/25-hour DST days.
  const midnight = (day: string) =>
    Date.parse(zonedInstant(`${day}T00:00:00`, zone));
  const startAt = midnight(start);
  const endAt = midnight(addDays(end, 1));
  // The weeks whose Sunday is in the dates, by their Monday IDs; none when the dates hold no Sunday.
  const firstWeek = planningWeekId(addDays(start, 6));
  const lastWeek = planningWeekId(end);
  const boundaries = [startAt, ...days.slice(1).map(midnight), endAt];
  const ranges = days.map((day, index) => ({
    day,
    start: boundaries[index],
    end: boundaries[index + 1],
  }));
  const values = [
    startAt,
    endAt,
    start,
    end,
    firstWeek,
    lastWeek,
    area,
  ];
  const [marker, completionDays, timeDays, planCounts, progress] =
    await storage(() =>
      db.batch([
        db.prepare("SELECT started_at FROM gtd_reporting WHERE id='report'"),
        db
          .prepare(
            `SELECT d.value->>'day' AS day,
      sum(t.kind='task' AND NOT ${routine("t")}) AS task_count,
      sum(t.kind='step' AND NOT ${routine("t")}) AS step_count,
      sum(${routine("t")}) AS routine_count,sum(t.id IS NULL) AS unclassified_count
      FROM json_each(?8) d JOIN completions c INDEXED BY completions_report_time
        ON c.completed_at>=d.value->>'start' AND c.completed_at<d.value->>'end'
      LEFT JOIN tasks t ON t.id=c.task_id WHERE ${taskArea} GROUP BY d.value->>'day'`,
          )
          .bind(...values, JSON.stringify(ranges)),
        db
          .prepare(
            `SELECT f.day,sum(f.seconds) AS seconds,
      sum(CASE WHEN f.area='work' THEN f.seconds ELSE 0 END) AS work_seconds,
      sum(CASE WHEN f.area='personal' THEN f.seconds ELSE 0 END) AS personal_seconds,
      sum(CASE WHEN f.area='' THEN f.seconds ELSE 0 END) AS unassigned_seconds,
      sum(CASE WHEN ${routine("t")} THEN f.seconds ELSE 0 END) AS routine_seconds
      FROM focus_entries f LEFT JOIN tasks t ON t.id=f.task_id
      WHERE f.day BETWEEN ?3 AND ?4 AND f.deleted_at IS NULL AND ${recordArea} GROUP BY f.day`,
          )
          .bind(...values),
        db
          .prepare(
            `WITH ${planned} SELECT
      coalesce(sum(t.kind='task'),0) AS task_count,coalesce(sum(t.kind='step'),0) AS step_count,
      coalesce(sum(t.kind='task' AND EXISTS(SELECT 1 FROM completions c INDEXED BY completions_task_time
        WHERE c.task_id=p.task_id AND c.completed_at>=?8 AND c.completed_at<?9)),0) AS task_done,
      coalesce(sum(t.kind='step' AND EXISTS(SELECT 1 FROM completions c INDEXED BY completions_task_time
        WHERE c.task_id=p.task_id AND c.completed_at>=?1 AND c.completed_at<?2)),0) AS step_done
      FROM planned p JOIN tasks t ON t.id=p.task_id`,
          )
          .bind(
            ...values,
            midnight(addDays(firstWeek, -1)),
            midnight(addDays(lastWeek, 6)),
          ),
        db
          .prepare(
            `WITH ${planned},${completed},${timed}, named AS (
      SELECT task_id FROM planned UNION SELECT task_id FROM completed UNION SELECT task_id FROM timed)
      SELECT t.id,t.title,t.kind,t.parent_id,coalesce(p.title,'') AS parent_title,
        coalesce(p.duration_minutes,0) AS parent_duration_minutes,${effectiveArea} AS area,${routine("t")} AS routine,
        t.duration_minutes,coalesce(c.completion_count,0) AS completion_count,c.last_completed_at,
        coalesce(f.recorded_seconds,0) AS recorded_seconds,m.task_id IS NOT NULL AS planned,t.completed,
        (SELECT count(*) FROM tasks s WHERE s.parent_id=t.id AND s.kind='step' AND s.deleted_at IS NULL) AS step_count,
        (SELECT count(*) FROM tasks s WHERE s.parent_id=t.id AND s.kind='step' AND s.deleted_at IS NULL AND s.completed=1) AS completed_step_count
      FROM named n JOIN tasks t ON t.id=n.task_id LEFT JOIN tasks p ON p.id=t.parent_id
        LEFT JOIN completed c ON c.task_id=t.id LEFT JOIN timed f ON f.task_id=t.id
        LEFT JOIN planned m ON m.task_id=t.id
      ORDER BY recorded_seconds DESC,completion_count DESC,planned DESC,t.id LIMIT ${String(REPORT_TASKS + 1)}`,
          )
          .bind(...values),
      ]),
    );
  const counts = new Map(
    (completionDays?.results as unknown as DayCounts[]).map((row) => [
      row.day,
      row,
    ]),
  );
  const times = new Map(
    (timeDays?.results as unknown as DayTime[]).map((row) => [row.day, row]),
  );
  const dayMessages = days.map((day) => {
    const count = counts.get(day);
    const time = times.get(day);
    return create(GtdReportDaySchema, {
      day,
      taskCompletionCount: count?.task_count ?? 0,
      stepCompletionCount: count?.step_count ?? 0,
      routineCompletionCount: count?.routine_count ?? 0,
      unclassifiedCompletionCount: count?.unclassified_count ?? 0,
      recordedSeconds: time?.seconds ?? 0,
      workSeconds: time?.work_seconds ?? 0,
      personalSeconds: time?.personal_seconds ?? 0,
      unassignedSeconds: time?.unassigned_seconds ?? 0,
    });
  });
  const startedAt = (marker?.results[0] as { started_at: number } | undefined)
    ?.started_at;
  const completeHistory =
    startedAt !== undefined &&
    firstWeek >= addDays(planningWeekId(localDate(startedAt, zone)), 7);
  const plan = planCounts?.results[0] as {
    task_count: number;
    step_count: number;
    task_done: number;
    step_done: number;
  };
  const taskRows = progress?.results as unknown as TaskProgressRow[];
  const sum = (
    key:
      | "taskCompletionCount"
      | "stepCompletionCount"
      | "routineCompletionCount"
      | "unclassifiedCompletionCount"
      | "recordedSeconds"
      | "workSeconds"
      | "personalSeconds"
      | "unassignedSeconds",
  ) => dayMessages.reduce((total, day) => total + day[key], 0);
  return create(GtdReportSchema, {
    name: "gtdReport",
    startDay: start,
    endDay: end,
    today: localDate(now, zone),
    timeZone: zone,
    area,
    taskCompletionCount: sum("taskCompletionCount"),
    stepCompletionCount: sum("stepCompletionCount"),
    routineCompletionCount: sum("routineCompletionCount"),
    unclassifiedCompletionCount: sum("unclassifiedCompletionCount"),
    taskPlanHistoryComplete: completeHistory,
    ...(completeHistory
      ? {
          plannedTaskCount: plan.task_count,
          completedPlannedTaskCount: plan.task_done,
        }
      : {}),
    plannedStepCount: plan.step_count,
    completedPlannedStepCount: plan.step_done,
    recordedSeconds: sum("recordedSeconds"),
    workSeconds: sum("workSeconds"),
    personalSeconds: sum("personalSeconds"),
    unassignedSeconds: sum("unassignedSeconds"),
    routineRecordedSeconds: [...times.values()].reduce(
      (total, day) => total + day.routine_seconds,
      0,
    ),
    days: dayMessages,
    tasksTruncated: taskRows.length > REPORT_TASKS,
    tasks: taskRows.slice(0, REPORT_TASKS).map((row) =>
      create(GtdTaskProgressSchema, {
        taskId: row.id,
        title: row.title,
        kind: row.kind,
        parentId: row.parent_id,
        parentTitle: row.parent_title,
        parentDurationMinutes: row.parent_duration_minutes,
        area: row.area,
        routine: row.routine === 1,
        durationMinutes: row.duration_minutes,
        completionCount: row.completion_count,
        recordedSeconds: row.recorded_seconds,
        planned: row.planned === 1,
        completed: row.completed === 1,
        stepCount: row.step_count,
        completedStepCount: row.completed_step_count,
        lastCompletedDay:
          row.last_completed_at === null
            ? ""
            : localDate(row.last_completed_at, zone),
      }),
    ),
  });
}
