import type { CSSProperties } from "react";
import { displayedTitle, taskAncestors } from "./domain";
import { areaColor } from "./planning-outcomes";
import type { Language, PlanningTask } from "./model";

export function TaskBreadcrumb({
  task,
  tasks,
  language,
}: {
  task: PlanningTask;
  tasks: PlanningTask[];
  language: Language;
}) {
  const parents = taskAncestors(task, tasks);
  if (!parents.length) return null;
  return (
    <small
      className="plus-task-breadcrumb"
      style={{ "--area-color": areaColor(task, tasks) } as CSSProperties}
      aria-label={language === "zh" ? "所属任务" : "Parent task"}
      title={parents.map((parent) => displayedTitle(parent.title)).join(" › ")}
    >
      {parents.map((parent) => displayedTitle(parent.title)).join(" › ")}
    </small>
  );
}
