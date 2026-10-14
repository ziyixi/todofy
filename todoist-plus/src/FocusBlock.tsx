import { useDraggable, useDroppable } from "@dnd-kit/react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  GripVertical,
  Pause,
  Play,
  Square,
  X,
} from "lucide-react";
import type { CSSProperties } from "react";
import { displayedTitle, duration, elapsed, formattedMinutes } from "./domain";
import { TaskBreadcrumb } from "./TaskFamily";
import { words } from "./i18n";
import type {
  FlowDayPlan,
  FocusState,
  Language,
  PlanState,
  PlanningTask,
  PlusActions,
} from "./model";

interface Props {
  task: PlanningTask;
  plan: PlanState;
  focus: FocusState;
  day: FlowDayPlan;
  native: boolean;
  index: number;
  queueIds: string[];
  offset: number;
  minutes: number;
  language: Language;
  today: string;
  busy: boolean;
  actions: PlusActions;
  run: (operation: () => Promise<void>) => Promise<boolean>;
  editTask: (task: PlanningTask) => void;
  complete: (task: PlanningTask) => void;
}

export function FocusBlock({
  task,
  plan,
  focus,
  day,
  native,
  index,
  queueIds,
  offset,
  minutes,
  language,
  today,
  busy,
  actions,
  run,
  editTask,
  complete,
}: Props) {
  const text = words(language);
  const title = displayedTitle(task.title);
  const timer =
    focus.timer?.taskId === task.id && focus.timer.flowDate === focus.date
      ? focus.timer
      : undefined;
  const { ref, handleRef, isDragSource } = useDraggable({
    id: `focus-step:${focus.date}:${task.id}`,
    type: "plus-step",
    disabled: busy || Boolean(timer),
    data: { taskId: task.id, sourceDate: focus.date },
  });
  const { ref: dropRef, isDropTarget } = useDroppable({
    id: `focus-before:${focus.date}:${task.id}`,
    type: "day",
    accept: "plus-step",
    disabled: busy,
    data: { date: focus.date, beforeId: task.id },
    collisionPriority: 2,
  });
  const estimateValues = [
    ...new Set([15, 30, 45, 60, 90, 120, ...(minutes ? [minutes] : [])]),
  ].sort((a, b) => a - b);
  let status = "";
  if (index === 0) status = language === "zh" ? "下一步" : "Up next";
  let timerAction: "start" | "pause" | "resume" = "start";
  if (timer) {
    status =
      timer.status === "running"
        ? language === "zh"
          ? "正在做"
          : "Now"
        : text.pause;
    timerAction = timer.status === "running" ? "pause" : "resume";
  }
  return (
    <li
      ref={dropRef}
      data-task-id={task.id}
      className={`plus-focus-slot ${isDropTarget && !isDragSource ? "is-drop-target" : ""}`}
    >
      <span
        className="plus-focus-offset"
        title={language === "zh" ? "累计预计用时" : "Cumulative estimated time"}
      >
        +{Math.floor(offset / 60)}:{String(offset % 60).padStart(2, "0")}
      </span>
      <article
        ref={ref}
        className={`plus-focus-block ${timer ? "is-current" : ""} ${isDragSource ? "is-dragging" : ""} ${native ? "" : "is-local"}`}
        style={
          {
            "--plus-block-height": `${Math.max(84, Math.min(220, 60 + minutes))}px`,
          } as CSSProperties
        }
      >
        <button
          ref={handleRef}
          className="plus-focus-grip"
          disabled={busy || Boolean(timer)}
          aria-label={`${language === "zh" ? "拖动步骤" : "Drag step"}: ${title}`}
        >
          <GripVertical size={18} />
        </button>
        {native && (
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
            {native ? (
              <TaskBreadcrumb
                task={task}
                tasks={plan.tasks}
                language={language}
              />
            ) : (
              <span className="plus-muted">
                {focus.flowTasks[task.id]?.local ||
                task.id.startsWith("__flowday_")
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
          <button
            className="plus-focus-title"
            disabled={!native}
            onClick={() => editTask(task)}
          >
            {title}
          </button>
          <div className="plus-focus-block-footer">
            {native ? (
              <label className="plus-focus-estimate">
                <span className="plus-sr-only">
                  {text.estimate}: {title}
                </span>
                <select
                  aria-label={`${text.estimate}: ${title}`}
                  value={minutes}
                  disabled={busy}
                  onChange={(event) =>
                    void run(() =>
                      actions.updateEstimate(
                        task.id,
                        Number(event.target.value),
                      ),
                    )
                  }
                >
                  <option value={0}>{text.unknown}</option>
                  {estimateValues.map((value) => (
                    <option key={value} value={value}>
                      {formattedMinutes(value)}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span className="plus-muted">
                {minutes ? formattedMinutes(minutes) : text.unknown}
              </span>
            )}
            {timer && (
              <output
                aria-label={language === "zh" ? "已专注" : "Time focused"}
              >
                {duration(elapsed(focus))}
              </output>
            )}
            <div className="plus-focus-block-tools">
              <button
                className="plus-icon"
                aria-label={`${text.up}: ${title}`}
                disabled={busy || index === 0}
                onClick={() =>
                  void run(() =>
                    actions.moveTaskToDay(
                      task.id,
                      day,
                      day,
                      queueIds[index - 1],
                    ),
                  )
                }
              >
                <ArrowUp size={13} />
              </button>
              <button
                className="plus-icon"
                aria-label={`${text.down}: ${title}`}
                disabled={busy || index === queueIds.length - 1}
                onClick={() =>
                  void run(() =>
                    actions.moveTaskToDay(
                      task.id,
                      day,
                      day,
                      queueIds[index + 2],
                    ),
                  )
                }
              >
                <ArrowDown size={13} />
              </button>
              <button
                className="plus-icon"
                aria-label={`${language === "zh" ? "移出当天" : "Remove from day"}: ${title}`}
                disabled={busy || Boolean(timer)}
                onClick={() =>
                  void run(() =>
                    actions.updateQueue(
                      day.taskIds.filter((id) => id !== task.id),
                      day,
                    ),
                  )
                }
              >
                <X size={13} />
              </button>
            </div>
            {!native && plan.flowdayUrl && (
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
        {native && (
          <div className="plus-focus-timer-controls">
            <button
              className="plus-icon plus-play"
              aria-label={`${text[timerAction]}: ${title}`}
              disabled={
                busy ||
                Boolean(focus.timer && !timer) ||
                (!timer && focus.date !== today)
              }
              onClick={() =>
                void run(() => actions.timer(timerAction, task.id, focus))
              }
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
                onClick={() =>
                  void run(() => actions.timer("stop", task.id, focus))
                }
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
