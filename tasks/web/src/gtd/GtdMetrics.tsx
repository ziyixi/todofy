import type { GtdReport } from "@ziyixi/proto/tasks/ui/v1/gtd_pb";
import { loggedTime, percentage } from "./model";

function CompletionMetric({
  title,
  done,
  total,
  completions,
}: {
  title: string;
  done: number;
  total?: number;
  completions: number;
}) {
  const planned = total !== undefined && total > 0;
  return (
    <div className="gtd-metric">
      <dt>
        {planned
          ? title
          : `${title === "Committed Tasks" ? "Tasks" : "Steps"} completed`}
      </dt>
      <dd>
        {planned ? (
          <>
            {done.toLocaleString()} <span>/ {total.toLocaleString()}</span>
          </>
        ) : (
          completions.toLocaleString()
        )}
      </dd>
      {planned ? (
        <>
          <span className="gtd-metric-detail">
            {percentage(done, total)}% complete
          </span>
          <progress
            value={done}
            max={total}
            aria-label={`${title} completion`}
          />
          <small>{completions} completions in this period</small>
        </>
      ) : (
        <small>
          {total === undefined
            ? "Plan history is not available for this period"
            : "No planned items in this period"}
        </small>
      )}
    </div>
  );
}

export function CompletionMetrics({
  report,
  time = false,
}: {
  report: GtdReport;
  time?: boolean;
}) {
  return (
    <>
      <dl className="gtd-metrics">
        <CompletionMetric
          title="Committed Tasks"
          done={report.completedPlannedTaskCount ?? 0}
          total={report.plannedTaskCount}
          completions={report.taskCompletionCount}
        />
        <CompletionMetric
          title="Scheduled Steps"
          done={report.completedPlannedStepCount}
          total={report.plannedStepCount}
          completions={report.stepCompletionCount}
        />
        {time ? (
          <div className="gtd-metric">
            <dt>Recorded time</dt>
            <dd>{loggedTime(report.recordedSeconds)}</dd>
            <small>
              Work {loggedTime(report.workSeconds)} · Personal{" "}
              {loggedTime(report.personalSeconds)}
              {report.unassignedSeconds > 0 &&
                ` · No area ${loggedTime(report.unassignedSeconds)}`}
            </small>
          </div>
        ) : (
          <div className="gtd-metric gtd-routine-metric">
            <dt>Routine</dt>
            <dd>{report.routineCompletionCount.toLocaleString()}</dd>
            <small>completions, shown separately</small>
          </div>
        )}
      </dl>
      <p className="gtd-note gtd-metric-note">
        Task rates count each week starting in these dates, through its
        Saturday. Steps use scheduled dates; Routine is separate.
      </p>
      {report.unclassifiedCompletionCount > 0 && (
        <p className="gtd-note">
          {report.unclassifiedCompletionCount} older completions have no task
          properties and are not assigned a type.
        </p>
      )}
    </>
  );
}
