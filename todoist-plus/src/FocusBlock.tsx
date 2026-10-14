import { Check, Pause, Play, Square } from "lucide-react";
import type { CSSProperties } from "react";
import {
  displayedTitle,
  duration,
  elapsed,
  formattedMinutes,
  taskFamilyColor,
} from "./domain";
import { TaskBreadcrumb } from "./TaskFamily";
import { words } from "./i18n";
import type { FocusState, Language, PlanState, PlanningTask } from "./model";

interface Props {
  taskId: string;
  task?: PlanningTask;
  plan: PlanState;
  focus: FocusState;
  index: number;
  minutes: number;
  language: Language;
  busy: boolean;
  onTimer: (
    action: "start" | "pause" | "resume" | "stop",
    taskId: string,
  ) => void;
  editTask: (task: PlanningTask) => void;
  complete: (task: PlanningTask) => void;
}

export function FocusBlock({
  taskId,
  task,
  plan,
  focus,
  index,
  minutes,
  language,
  busy,
  onTimer,
  editTask,
  complete,
}: Props) {
  const text = words(language);
  let fallbackTitle = text.missingTask;
  if (taskId.startsWith("__flowday_misc__"))
    fallbackTitle = language === "zh" ? "杂项时间" : "Miscellaneous time";
  const title = displayedTitle(
    task?.title ?? focus.flowTasks[taskId]?.title ?? fallbackTitle,
  );
  const timer =
    focus.timer?.taskId === taskId && focus.timer.flowDate === focus.date
      ? focus.timer
      : undefined;
  let status = "";
  if (index === 0) status = language === "zh" ? "下一步" : "Up next";
  let timerAction: "start" | "pause" | "resume" = "start";
  if (timer) {
    status = text.pause;
    if (timer.status === "running")
      status = language === "zh" ? "正在做" : "Now";
    timerAction = timer.status === "running" ? "pause" : "resume";
  }
  const familyColor = task
    ? taskFamilyColor(task, plan.tasks)
    : "var(--plus-muted)";
  return (
    <li className="plus-focus-slot" data-task-id={taskId}>
      <article
        className={`plus-focus-block ${timer ? "is-current" : ""}`}
        style={{ "--plus-family-color": familyColor } as CSSProperties}
      >
        {task && (
          <button
            className="plus-checkbox"
            aria-label={`${text.complete}: ${title}`}
            disabled={busy}
            onClick={() => complete(task)}
          >
            <Check size={13} />
          </button>
        )}
        <div className="plus-focus-block-content">
          <div className="plus-focus-block-top">
            {task ? (
              <TaskBreadcrumb
                task={task}
                tasks={plan.tasks}
                language={language}
              />
            ) : (
              <span className="plus-muted">
                {focus.flowTasks[taskId]?.local ||
                taskId.startsWith("__flowday_")
                  ? text.local
                  : text.missingTask}
              </span>
            )}
            {status && (
              <span
                className={`plus-focus-status ${timer ? "is-current" : ""}`}
              >
                {status}
              </span>
            )}
          </div>
          {task ? (
            <button className="plus-focus-title" onClick={() => editTask(task)}>
              {title}
            </button>
          ) : (
            <span className="plus-focus-title">{title}</span>
          )}
          <div className="plus-focus-block-footer">
            <span className="plus-focus-estimate">
              {minutes ? formattedMinutes(minutes) : text.unknown}
            </span>
            {timer && (
              <output
                aria-label={language === "zh" ? "已专注" : "Time focused"}
              >
                {duration(elapsed(focus))}
              </output>
            )}
            {!task && plan.flowdayUrl && (
              <a
                className="plus-text-button"
                href={plan.flowdayUrl}
                target="_blank"
                rel="noreferrer"
              >
                {text.openFlowday}
              </a>
            )}
          </div>
        </div>
        {task && (
          <div className="plus-focus-timer-controls">
            <button
              className="plus-icon plus-play"
              aria-label={`${text[timerAction]}: ${title}`}
              disabled={busy || Boolean(focus.timer && !timer)}
              onClick={() => onTimer(timerAction, taskId)}
            >
              {timer?.status === "running" ? (
                <Pause size={17} />
              ) : (
                <Play size={17} />
              )}
            </button>
            {timer && (
              <button
                className="plus-icon"
                aria-label={`${text.stop}: ${title}`}
                disabled={busy}
                onClick={() => onTimer("stop", taskId)}
              >
                <Square size={13} />
              </button>
            )}
          </div>
        )}
      </article>
    </li>
  );
}
