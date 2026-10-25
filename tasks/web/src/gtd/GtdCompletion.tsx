import { useState } from "react";
import type { GtdReport } from "@ziyixi/proto/tasks/ui/v1/gtd_pb";
import { mondayOf } from "@ziyixi/planning-ui/domain";
import { loggedTime, progressGroups, type GtdPeriod } from "./model";
import { CompletionMetrics } from "./GtdMetrics";
import { Routine, StepRow, TaskRow } from "./GtdProgress";

type ReportProps = {
  report: GtdReport;
  period: GtdPeriod;
  onOpenTask: (id: string) => void;
};

/** Counts of completions, kept distinct from plan-completion percentages. */
function CompletionBars({
  report,
  period,
}: {
  report: GtdReport;
  period: GtdPeriod;
}) {
  const buckets = new Map<
    string,
    { label: string; tasks: number; steps: number }
  >();
  for (const day of report.days) {
    const key = period === "week" ? day.day : mondayOf(day.day);
    const label = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      ...(period === "week"
        ? { weekday: "short" as const }
        : { month: "short" as const, day: "numeric" as const }),
    }).format(new Date(`${key}T12:00:00Z`));
    const bucket = buckets.get(key) ?? { label, tasks: 0, steps: 0 };
    bucket.tasks += day.taskCompletionCount;
    bucket.steps += day.stepCompletionCount;
    buckets.set(key, bucket);
  }
  const peak = Math.max(
    1,
    ...[...buckets.values()].flatMap((item) => [item.tasks, item.steps]),
  );
  return (
    <section
      className="gtd-completion-chart"
      aria-label={period === "week" ? "Completed by day" : "Completed by week"}
    >
      <div className="gtd-section-heading">
        <h2>{period === "week" ? "Completed by day" : "Completed by week"}</h2>
        <div className="gtd-legend">
          <span>Tasks</span>
          <span>Steps</span>
        </div>
      </div>
      <div className="gtd-completion-bars">
        {[...buckets].map(([day, item]) => (
          <div
            className="gtd-completion-column"
            key={day}
            aria-label={`${item.label}: ${item.tasks} Tasks and ${item.steps} Steps completed`}
          >
            <div className="gtd-completion-pair">
              <span style={{ height: `${(item.tasks / peak) * 100}%` }}>
                <small>{item.tasks}</small>
              </span>
              <span style={{ height: `${(item.steps / peak) * 100}%` }}>
                <small>{item.steps}</small>
              </span>
            </div>
            <span className="gtd-note">{item.label}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function GtdOverview({ report, period, onOpenTask }: ReportProps) {
  const groups = progressGroups(report);
  const total = report.recordedSeconds;
  return (
    <>
      <CompletionMetrics report={report} time />
      <div className="gtd-columns">
        <section>
          <div className="gtd-section-heading">
            <h2>Task progress</h2>
            <a className="text-button" href="#/gtd/completion">
              View completion →
            </a>
          </div>
          {groups.length ? (
            <div className="gtd-progress-list">
              {groups.slice(0, 4).map((group) => (
                <TaskRow
                  key={group.id}
                  group={group}
                  today={report.today}
                  onOpenTask={onOpenTask}
                  compact
                />
              ))}
            </div>
          ) : (
            <p className="gtd-empty">
              No planned or completed work in this period.
            </p>
          )}
          {groups.length > 4 && (
            <a className="text-button gtd-more" href="#/gtd/completion">
              See all {groups.length} related Tasks
            </a>
          )}
        </section>
        <div className="gtd-side">
          <CompletionBars report={report} period={period} />
          <section className="gtd-time-allocation">
            <div className="gtd-section-heading">
              <h2>Time allocation</h2>
              <a className="text-button" href="#/gtd/time">
                Explore time →
              </a>
            </div>
            {(
              [
                ["Work", report.workSeconds],
                ["Personal", report.personalSeconds],
                ...(report.unassignedSeconds
                  ? [["No area", report.unassignedSeconds] as const]
                  : []),
              ] as const
            ).map(([title, seconds]) => (
              <div className="gtd-allocation-row" key={title}>
                <span>{title}</span>
                <strong>{loggedTime(seconds)}</strong>
                <progress
                  value={seconds}
                  max={total || 1}
                  aria-label={`${title} recorded time`}
                />
              </div>
            ))}
          </section>
        </div>
      </div>
      {report.tasksTruncated && (
        <p className="gtd-note">
          Showing 100 related tasks. Summary totals include the full period.
        </p>
      )}
      <Routine report={report} onOpenTask={onOpenTask} />
    </>
  );
}

export function GtdCompletion({ report, period, onOpenTask }: ReportProps) {
  const [kind, setKind] = useState("all");
  const groups = progressGroups(report);
  const steps = report.tasks.filter(
    (task) =>
      task.kind === "step" &&
      !task.routine &&
      (task.planned || task.completionCount > 0),
  );
  return (
    <>
      <CompletionMetrics report={report} />
      <div className="gtd-columns gtd-completion-columns">
        <section>
          <div className="gtd-section-heading">
            <h2>Task progress</h2>
            <select
              aria-label="Completion item type"
              value={kind}
              onChange={(event) => setKind(event.target.value)}
            >
              <option value="all">Tasks &amp; Steps</option>
              <option value="task">Tasks</option>
              <option value="step">Steps</option>
            </select>
          </div>
          <p className="gtd-note">
            Step progress shows current children; completion dates refer to this
            period.
          </p>
          <div className="gtd-progress-list">
            {kind === "step"
              ? steps.map((step) => (
                  <StepRow
                    key={step.taskId}
                    step={step}
                    today={report.today}
                    onOpenTask={onOpenTask}
                  />
                ))
              : groups.map((group) => (
                  <TaskRow
                    key={group.id}
                    group={group}
                    today={report.today}
                    onOpenTask={onOpenTask}
                    compact={kind === "task"}
                  />
                ))}
          </div>
          {!(kind === "step" ? steps.length : groups.length) && (
            <p className="gtd-empty">No matching work in this period.</p>
          )}
          {report.tasksTruncated && (
            <p className="gtd-note">
              Showing 100 related tasks. Summary totals include the full period.
            </p>
          )}
        </section>
        <div className="gtd-side">
          <CompletionBars report={report} period={period} />
          <p className="gtd-note">
            {report.taskCompletionCount} Task completions ·{" "}
            {report.stepCompletionCount} Step completions
          </p>
          <a className="text-button gtd-more" href="#/completed">
            Open completion history →
          </a>
        </div>
      </div>
      <Routine report={report} onOpenTask={onOpenTask} />
    </>
  );
}
