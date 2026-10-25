import { Check, ChevronRight, ListTree } from "lucide-react";
import type {
  GtdReport,
  GtdTaskProgress,
} from "@ziyixi/proto/tasks/ui/v1/gtd_pb";
import {
  areaLabel,
  completedDayLabel,
  loggedTime,
  progressGroups,
  type ProgressGroup,
} from "./model";

function Status({ complete }: { complete: boolean }) {
  return (
    <span
      className={`gtd-completion-mark${complete ? " is-complete" : ""}`}
      aria-label={complete ? "Completed" : "Open"}
    >
      {complete && <Check size={14} />}
    </span>
  );
}

export function StepRow({
  step,
  today,
  onOpenTask,
}: {
  step: GtdTaskProgress;
  today: string;
  onOpenTask: (id: string) => void;
}) {
  return (
    <div className="gtd-step-row">
      <Status complete={step.completed} />
      <div className="gtd-task-main">
        <button
          className="gtd-task-title"
          onClick={() => onOpenTask(step.taskId)}
        >
          {step.title}
        </button>
        <span className="gtd-note">
          Step{step.parentTitle ? ` · ${step.parentTitle}` : ""}
        </span>
      </div>
      <span className="gtd-completed-date">
        {completedDayLabel(step.lastCompletedDay, today)}
      </span>
    </div>
  );
}

export function TaskRow({
  group,
  today,
  onOpenTask,
  compact,
}: {
  group: ProgressGroup;
  today: string;
  onOpenTask: (id: string) => void;
  compact?: boolean;
}) {
  const task = group.task;
  const row = (
    <>
      {task ? (
        <Status complete={task.completed} />
      ) : (
        <ListTree
          size={20}
          className="gtd-parent-context"
          aria-label="Parent Task context"
        />
      )}
      <div className="gtd-task-main">
        <button
          className="gtd-task-title"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpenTask(group.id);
          }}
        >
          {group.title}
        </button>
        <span className="gtd-note">
          {task ? areaLabel(task.area) : "Task"}
          {task?.parentTitle && ` · ${task.parentTitle}`}
          {task &&
            task.stepCount > 0 &&
            compact &&
            ` · ${task.completedStepCount} / ${task.stepCount} Steps`}
        </span>
      </div>
      {task && task.stepCount > 0 && !compact && (
        <span className="gtd-task-progress">
          <span>
            {task.completedStepCount} / {task.stepCount} Steps
          </span>
          <progress
            max={task.stepCount}
            value={task.completedStepCount}
            aria-label={`Steps for ${group.title}`}
          />
        </span>
      )}
      {task && (
        <span className="gtd-completed-date">
          {completedDayLabel(task.lastCompletedDay, today)}
        </span>
      )}
    </>
  );
  if (compact || !group.steps.length)
    return <div className="gtd-task-row">{row}</div>;
  return (
    <details className="gtd-progress-details">
      <summary className="gtd-task-row">
        <ChevronRight size={15} className="gtd-chevron" aria-hidden="true" />
        {row}
      </summary>
      <div className="gtd-child-steps">
        {group.steps.map((step) => (
          <StepRow
            key={step.taskId}
            step={step}
            today={today}
            onOpenTask={onOpenTask}
          />
        ))}
      </div>
    </details>
  );
}

export function Routine({
  report,
  onOpenTask,
}: {
  report: GtdReport;
  onOpenTask: (id: string) => void;
}) {
  const groups = progressGroups(report, true);
  return (
    <details className="gtd-routine">
      <summary>
        <ChevronRight size={15} aria-hidden="true" />
        <strong>Routine</strong>
        <span>
          {report.routineCompletionCount} completions ·{" "}
          {loggedTime(report.routineRecordedSeconds)} recorded
        </span>
      </summary>
      {groups.length ? (
        groups.map((group) => (
          <TaskRow
            key={group.id}
            group={group}
            today={report.today}
            onOpenTask={onOpenTask}
          />
        ))
      ) : (
        <p className="gtd-note">No Routine completions in this period.</p>
      )}
    </details>
  );
}
