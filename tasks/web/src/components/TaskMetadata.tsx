import { CalendarDays, ChevronRight, Repeat2, Tag, Timer } from "lucide-react";
import type { Catalog, Task } from "../api";
import { dateLabel } from "../dates";
import { repeatLabel } from "../recurrence-controls";
import {
  planningDraft,
  TASK_OPTIONS,
  type PlanningTask,
} from "../task-planning";
import "./task-metadata.css";

const stages: Record<string, string> = {
  quarterly: "Quarter",
  monthly: "Month",
  weekly: "Week",
  committed: "Committed",
};

export function TaskMetadata({
  task,
  catalog,
  today,
  planning,
}: {
  task: Task;
  catalog: Catalog;
  today: string;
  planning?: PlanningTask;
}) {
  const due = task.dueDate || task.dueDatetime.slice(0, 10);
  const properties: string[] = [];
  if (planning?.explicitStage && stages[planning.explicitStage])
    properties.push(`#${stages[planning.explicitStage]}`);
  if (planning?.mustStart) properties.push("#Start now");
  if (task.deadline)
    properties.push(`#Deadline ${dateLabel(task.deadline, today)}`);
  if (task.effort === "deep") properties.push("#Deep");
  if (task.effort === "shallow") properties.push("#Shallow");
  const options = planningDraft(planning);
  for (const [field, , label] of TASK_OPTIONS) {
    if (options[field]) properties.push(`#${label}`);
  }
  if (planning?.area === "work") properties.push("#Work");
  if (planning?.area === "personal") properties.push("#Personal");
  if (planning?.leadDays && !planning.mustStart)
    properties.push(`#Start ${planning.leadDays}d`);
  const text = properties.join(" · ");
  const labels = task.labelIds.flatMap((id) => {
    const label = catalog.labels.find((value) => value.id === id);
    return label ? [label] : [];
  });
  return (
    <span className="task-meta">
      {due && (
        <span className={due < today && !task.completed ? "overdue" : ""}>
          <CalendarDays size={12} />
          {dateLabel(due, today)}
          {task.dueDatetime &&
            ` ${new Date(task.dueDatetime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: task.dueTimezone || catalog.timeZone || undefined })}`}
        </span>
      )}
      {task.recurrence && (
        <span title={task.recurrence}>
          <Repeat2 size={12} />
          {repeatLabel(task.recurrence)}
        </span>
      )}
      {task.childCount > 0 && (
        <span>
          <ChevronRight size={12} />
          {task.completedChildCount}/{task.childCount}
        </span>
      )}
      {task.durationMinutes > 0 && (
        <span>
          <Timer size={12} />
          {task.durationMinutes}m
        </span>
      )}
      <span
        className="task-native-properties"
        title={text ? `Task properties: ${text}` : undefined}
      >
        {text}
      </span>
      {labels.length > 0 && (
        <span
          className="task-real-labels"
          title={`Labels: ${labels.map((label) => label.title).join(", ")}`}
        >
          {labels.map((label) => (
            <span key={label.id} style={{ color: label.color || undefined }}>
              <Tag size={11} />
              {label.title.startsWith("#") ? label.title : `#${label.title}`}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
