import { ChevronRight } from "lucide-react";
import { displayedTitle } from "./domain";
import { waitingDeadline } from "./deadlines";
import { Status } from "./DeadlineList";
import { words } from "./i18n";
import {
  oldestUntouched,
  untouchedDays,
  WAITING_LABELS,
} from "./weekly-review";
import type { Language, PlanningTask } from "./model";

/**
 * "12 天未变动", in whole 24-hour periods: any Todoist edit resets it, so it never claims how
 * long the wait has been.
 */
export function untouchedText(task: PlanningTask, language: Language): string {
  const days = untouchedDays(task);
  if (days === undefined) return "";
  if (language === "zh") return days ? `${days} 天未变动` : "1 天内有变动";
  return days
    ? `Untouched ${days} ${days === 1 ? "day" : "days"}`
    : "Changed within a day";
}

interface Props {
  tasks: PlanningTask[];
  /** The account's today, for the deadline text. */
  today: string;
  language: Language;
  busy: boolean;
  todayTaskIds: readonly string[];
  open: boolean;
  onToggle: (open: boolean) => void;
  editTask: (task: PlanningTask) => void;
  addStep: (task: PlanningTask) => void;
  addFocus: (id: string) => void;
  onOpenTask: (id: string) => void;
}

/**
 * @waiting and @blocked tasks, untouched the longest first, with their deadline. It only shows them
 * and offers the owner's existing actions, on hover or keyboard focus; it never removes a label or
 * contacts anyone.
 */
export function WaitingList({
  tasks,
  today,
  language,
  busy,
  todayTaskIds,
  open,
  onToggle,
  editTask,
  addStep,
  addFocus,
  onOpenTask,
}: Props) {
  const waiting = oldestUntouched(tasks, WAITING_LABELS);
  if (!waiting.length) return null;
  const text = words(language);
  const zh = language === "zh";
  const queued = new Set(todayTaskIds);
  return (
    <details
      className="planning-attention planning-waiting"
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary>
        <ChevronRight size={14} aria-hidden="true" />
        {text.waiting} · {waiting.length}
      </summary>
      <ul className="planning-rows" aria-label={text.waiting}>
        {waiting.map((task) => {
          const title = displayedTitle(task.title);
          const planned = queued.has(task.id);
          const untouched = untouchedText(task, language);
          const deadline = waitingDeadline(task, today, language);
          const separator = untouched && deadline ? " · " : "";
          return (
            <li key={task.id}>
              <button
                className="planning-row-title"
                onClick={() => editTask(task)}
              >
                {title}
              </button>
              <Status
                status={{
                  text: untouched + separator + (deadline?.text ?? ""),
                  danger: deadline?.danger,
                }}
                deadline={task.deadline}
                language={language}
              />
              <span className="planning-row-actions">
                {/* Opening the editor writes nothing; its own controls wait while busy. */}
                <button
                  aria-label={`${text.followUp}: ${title}`}
                  onClick={() => addStep(task)}
                >
                  {text.followUp}
                </button>
                <button
                  disabled={busy || planned}
                  aria-label={`${planned ? text.inToday : text.addFocus}: ${title}`}
                  onClick={() => addFocus(task.id)}
                >
                  {planned ? text.inToday : text.addFocus}
                </button>
                <button
                  aria-label={`${text.open}: ${title}`}
                  onClick={() => onOpenTask(task.id)}
                >
                  {zh ? "打开" : "Open"}
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
