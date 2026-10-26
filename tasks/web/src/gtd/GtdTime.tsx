import { useId, type CSSProperties } from "react";
import { ArrowRight } from "lucide-react";
import type { GtdReport } from "@ziyixi/proto/tasks/ui/v1/gtd_pb";
import {
  addDays,
  displayedTitle,
  formattedMinutes,
  planningWeekStart,
  monthStart,
} from "@ziyixi/planning-ui/domain";
import { readableDate, shortDay } from "@ziyixi/planning-ui/PlanningCalendar";
import { loggedTime as recordedTime, type GtdPeriod } from "./model";
import "./gtd-time.css";

type ReportDay = GtdReport["days"][number];

function dayName(day: ReportDay): string {
  const areas = [
    day.workSeconds > 0 && `Work ${recordedTime(day.workSeconds)}`,
    day.personalSeconds > 0 && `Personal ${recordedTime(day.personalSeconds)}`,
    day.unassignedSeconds > 0 &&
      `Unassigned ${recordedTime(day.unassignedSeconds)}`,
  ].filter(Boolean);
  return `${readableDate(day.day, "en")}: ${recordedTime(day.recordedSeconds)} recorded${areas.length ? `, ${areas.join(", ")}` : ""}`;
}

/** Recorded time uses its saved area; task metadata supplies only names and current estimates. */
export function GtdTime({
  report,
  period,
  onOpenDay,
  onOpenTask,
}: {
  report: GtdReport;
  period: GtdPeriod;
  onOpenDay: (day: string) => void;
  onOpenTask: (id: string) => void;
}) {
  const chartHeading = useId();
  const groupsHeading = useId();
  const groups = timeGroups(report.tasks);
  const recordDay =
    report.today >= report.startDay && report.today <= report.endDay
      ? report.today
      : report.endDay < report.today
        ? report.endDay
        : "";
  return (
    <div className="gtd-time">
      <dl className="gtd-time-metrics" aria-label="Recorded time totals">
        <div>
          <dt>Recorded time</dt>
          <dd>{recordedTime(report.recordedSeconds)}</dd>
          <dd className="gtd-time-metric-note">Tracked time only.</dd>
        </div>
        <div>
          <dt>Work</dt>
          <dd>{recordedTime(report.workSeconds)}</dd>
        </div>
        <div>
          <dt>Personal</dt>
          <dd>{recordedTime(report.personalSeconds)}</dd>
        </div>
        {report.unassignedSeconds > 0 && (
          <div>
            <dt>Unassigned</dt>
            <dd>{recordedTime(report.unassignedSeconds)}</dd>
          </div>
        )}
      </dl>
      <div className="gtd-time-content">
        <section className="gtd-time-chart" aria-labelledby={chartHeading}>
          <div className="gtd-time-heading">
            <h2 id={chartHeading}>Daily recorded time</h2>
            {period === "month" && (
              <div className="gtd-time-shades" aria-hidden="true">
                <span>Less</span>
                {[0, 1, 2, 3].map((level) => (
                  <i key={level} data-level={level} />
                ))}
                <span>More</span>
              </div>
            )}
          </div>
          {period === "month" ? (
            <TimeMonth report={report} onOpenDay={onOpenDay} />
          ) : (
            <TimeWeek report={report} onOpenDay={onOpenDay} />
          )}
          {report.recordedSeconds === 0 && (
            <p className="gtd-time-note">No recorded time this {period}.</p>
          )}
          <p className="gtd-time-note">
            Select a day to view its time records.
          </p>
        </section>
        <section className="gtd-time-tasks" aria-labelledby={groupsHeading}>
          <div className="gtd-time-task-heading">
            <h2 id={groupsHeading}>Time by task</h2>
            <span>Recorded</span>
            <span>Current estimate</span>
          </div>
          {groups.length > 0 ? (
            <ol>
              {groups.map((group) => (
                <li key={group.id}>
                  <div className="gtd-time-task-row">
                    <button
                      type="button"
                      className="gtd-time-task-title"
                      onClick={() => onOpenTask(group.id)}
                    >
                      {displayedTitle(group.title)}
                    </button>
                    <span>{recordedTime(group.seconds)}</span>
                    <span className="gtd-time-estimate">
                      {group.estimateMinutes > 0
                        ? formattedMinutes(group.estimateMinutes)
                        : "Unknown"}
                    </span>
                  </div>
                  {group.estimateMinutes > 0 && (
                    <div
                      className="gtd-time-task-bar"
                      title={`${recordedTime(group.seconds)} recorded / ${formattedMinutes(group.estimateMinutes)} current estimate`}
                      aria-hidden="true"
                    >
                      <span
                        style={{
                          width: `${Math.min(100, (group.seconds / (group.estimateMinutes * 60)) * 100)}%`,
                        }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="gtd-time-note">No task time recorded.</p>
          )}
          {report.tasksTruncated && (
            <p className="gtd-time-note">
              Task details are limited. Totals include all recorded time.
            </p>
          )}
          <p className="gtd-time-routine">
            <strong>Routine</strong>
            <span>
              {recordedTime(report.routineRecordedSeconds)} included above
            </span>
          </p>
          {recordDay && (
            <button
              type="button"
              className="text-button gtd-time-records"
              onClick={() => onOpenDay(recordDay)}
            >
              View time records <ArrowRight size={15} />
            </button>
          )}
        </section>
      </div>
    </div>
  );
}

function TimeMonth({
  report,
  onOpenDay,
}: {
  report: GtdReport;
  onOpenDay: (day: string) => void;
}) {
  const first = monthStart(report.startDay);
  const last = addDays(monthStart(first, 1), -1);
  const byDay = new Map(report.days.map((day) => [day.day, day]));
  const cells: string[] = [];
  for (
    let date = planningWeekStart(first);
    date <= addDays(planningWeekStart(last), 6);
    date = addDays(date, 1)
  )
    cells.push(date);
  return (
    <div className="plus-focus-month">
      {cells.slice(0, 7).map((date) => (
        <span key={date} className="plus-focus-weekday" aria-hidden="true">
          {shortDay(date, "en")}
        </span>
      ))}
      {cells.map((date) => {
        const outside = date.slice(0, 7) !== first.slice(0, 7);
        const future = date > report.today;
        const day = byDay.get(date);
        if (outside || future)
          return (
            <span
              key={date}
              className={`plus-focus-month-day ${outside ? "is-outside" : "is-future"}`}
              aria-hidden="true"
            >
              <span>{Number(date.slice(8))}</span>
            </span>
          );
        const seconds = day?.recordedSeconds ?? 0;
        const level = !seconds
          ? 0
          : seconds <= 3600
            ? 1
            : seconds <= 10800
              ? 2
              : 3;
        return (
          <button
            key={date}
            type="button"
            className={`plus-focus-month-day ${date === report.today ? "is-today" : ""}`}
            data-level={level}
            aria-label={
              day ? dayName(day) : `${readableDate(date, "en")}: 0m recorded`
            }
            onClick={() => onOpenDay(date)}
          >
            <span>{Number(date.slice(8))}</span>
            {seconds > 0 && <span>{recordedTime(seconds)}</span>}
          </button>
        );
      })}
    </div>
  );
}

function TimeWeek({
  report,
  onOpenDay,
}: {
  report: GtdReport;
  onOpenDay: (day: string) => void;
}) {
  const busiest = Math.max(0, ...report.days.map((day) => day.recordedSeconds));
  return (
    <div className="plus-focus-bars">
      {report.days.map((day) => (
        <button
          key={day.day}
          type="button"
          className={day.day === report.today ? "is-today" : undefined}
          disabled={day.day > report.today}
          aria-label={dayName(day)}
          onClick={() => onOpenDay(day.day)}
        >
          <span className="plus-focus-bar-track" aria-hidden="true">
            {day.recordedSeconds > 0 && (
              <span className="plus-focus-bar-value">
                {recordedTime(day.recordedSeconds)}
              </span>
            )}
            <span
              className="plus-focus-bar"
              style={
                {
                  "--share": busiest ? day.recordedSeconds / busiest : 0,
                } as CSSProperties
              }
            >
              {(["work", "personal", "unassigned"] as const).map((area) => {
                const seconds = day[`${area}Seconds`];
                return seconds > 0 ? (
                  <span
                    key={area}
                    data-area={area}
                    style={{ flexGrow: seconds }}
                  />
                ) : null;
              })}
            </span>
          </span>
          <span className="plus-focus-bar-day" aria-hidden="true">
            <span>{shortDay(day.day, "en")}</span>
            <span>{Number(day.day.slice(8))}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function timeGroups(tasks: GtdReport["tasks"]) {
  const groups = new Map<
    string,
    { id: string; title: string; seconds: number; estimateMinutes: number }
  >();
  for (const task of tasks) {
    if (task.recordedSeconds <= 0) continue;
    const groupWithParent = task.kind === "step" && Boolean(task.parentId);
    const id = groupWithParent ? task.parentId : task.taskId;
    const existing = groups.get(id);
    if (existing)
      groups.set(id, {
        ...existing,
        seconds: existing.seconds + task.recordedSeconds,
      });
    else
      groups.set(id, {
        id,
        title:
          (groupWithParent ? task.parentTitle : task.title) || "Missing task",
        seconds: task.recordedSeconds,
        estimateMinutes: groupWithParent
          ? task.parentDurationMinutes
          : task.durationMinutes,
      });
  }
  return [...groups.values()].sort(
    (a, b) => b.seconds - a.seconds || a.id.localeCompare(b.id),
  );
}
