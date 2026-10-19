import { Check } from "lucide-react";
import { displayedTitle } from "./domain";
import { words } from "./i18n";
import type { Language, PlanningTask } from "./model";

export type CompletePlanningTask = (
  task: PlanningTask,
  flowDate?: string,
) => void;

export function CompleteTaskButton({
  task,
  language,
  disabled,
  onComplete,
}: {
  task: PlanningTask;
  language: Language;
  disabled: boolean;
  onComplete: () => void;
}) {
  const label = `${words(language).complete}: ${displayedTitle(task.title)}`;
  return (
    <button
      type="button"
      className="plus-checkbox planning-complete"
      data-priority={task.priority}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onComplete}
    >
      <Check size={12} />
    </button>
  );
}
