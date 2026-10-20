import { Check, Pause, Play, Square } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import {
  displayedTitle,
  formattedMinutes,
  taskAncestors,
  taskIndex,
} from "./domain";
import { FocusLogged, recordArea, type RecordWrite } from "./FocusEntries";
import { words } from "./i18n";
import type {
  FocusEntry,
  FocusState,
  FocusTaskInfo,
  Language,
  PlanState,
  PlanningTask,
  PlusActions,
} from "./model";
import { areaColor, outcomeForTask } from "./planning-outcomes";
import { PendingMark } from "./StatusMarks";

/** A Focus card's title: Plan's, else Tasks' Focus read's, else that it is unavailable. */
export function focusTitle(
  task: PlanningTask | undefined,
  known: FocusTaskInfo | undefined,
  language: Language,
): string {
  return displayedTitle(
    task?.title ?? known?.title ?? words(language).missingTask,
  );
}

export interface FocusBlockProps {
  /**
   * Today's open step: complete, Start and the timer. A read-only one, on another day: no
   * controls. A completed one: no timer, and its title opens Tasks' own dialog.
   */
  mode?: "today" | "readonly" | "done";
  taskId: string;
  task?: PlanningTask;
  /** What Tasks' Focus read says of the task, which Plan may not list. */
  known?: FocusTaskInfo;
  plan: PlanState;
  focus: FocusState;
  /** The day the card is shown on. */
  date: string;
  index: number;
  minutes: number;
  /** The task's records on the day; absent on a future day, which has nothing to log yet. */
  records?: FocusEntry[];
  language: Language;
  busy: boolean;
  /** A queue change waits for confirmation, or a confirmed completion for its re-read. */
  settling?: boolean;
  /** Records whose write is not yet confirmed. */
  pending?: ReadonlySet<string>;
  actions: Pick<PlusActions, "addEntry" | "updateEntry" | "deleteEntry">;
  writeRecord: RecordWrite;
  onTimer: (
    action: "start" | "pause" | "resume" | "stop",
    taskId: string,
  ) => void;
  editTask: (task: PlanningTask) => void;
  complete: (task: PlanningTask) => void;
  onOpenTask?: (id: string) => void;
  /** A sortable step's: its row, its grip, and whether it is dragged or a drop lands by it. */
  slotRef?: (element: Element | null) => void;
  grip?: ReactNode;
  dragging?: boolean;
  insert?: "before" | "after";
}

export function FocusBlock({
  mode = "today",
  taskId,
  task,
  known,
  plan,
  focus,
  date,
  index,
  minutes,
  records,
  language,
  busy,
  settling = false,
  pending,
  actions,
  writeRecord,
  onTimer,
  editTask,
  complete,
  onOpenTask,
  slotRef,
  grip,
  dragging = false,
  insert,
}: FocusBlockProps) {
  const text = words(language);
  const done = mode === "done";
  const running = mode === "today";
  // A task Plan does not list has its title and parent from Tasks' Focus read.
  const title = focusTitle(task, known, language);
  // This card's session, when it counts on the card's day.
  const session =
    focus.timer?.taskId === taskId && focus.timer.day === date
      ? focus
      : undefined;
  const timer = running ? session?.timer : undefined;
  let status = "";
  if (index === 0 && running) status = language === "zh" ? "下一步" : "Up next";
  let timerAction: "start" | "pause" | "resume" = "start";
  if (timer) {
    status = text.paused;
    if (timer.status === "running")
      status = language === "zh" ? "正在做" : "Now";
    timerAction = timer.status === "running" ? "pause" : "resume";
  }
  const outcome = task ? outcomeForTask(task, plan.tasks) : undefined;
  // A task Plan does not list takes its parent's colour when Plan lists the parent, else none.
  const parent = known?.parentId
    ? taskIndex(plan.tasks).get(known.parentId)
    : undefined;
  const color = task
    ? areaColor(task, plan.tasks)
    : parent
      ? areaColor(parent, plan.tasks)
      : "var(--plus-area-none)";
  const parentPath = task
    ? taskAncestors(task, plan.tasks)
        .map((parent) => displayedTitle(parent.title))
        .join(" › ")
    : "";
  return (
    <li
      ref={slotRef}
      className={`plus-focus-slot ${dragging ? "is-dragging" : ""} ${insert ? `is-insert-${insert}` : ""}`}
      data-task-id={taskId}
    >
      <article
        className={`plus-focus-block ${timer ? "is-current" : ""} ${settling ? "is-pending" : ""} ${done ? "is-done" : ""}`}
        style={{ "--area-color": color } as CSSProperties}
        aria-busy={settling || undefined}
      >
        {grip}
        {done ? (
          <span
            className="plus-checkbox is-done"
            role="img"
            aria-label={text.completed}
          >
            <Check size={13} />
          </span>
        ) : task && running ? (
          <button
            className="plus-checkbox"
            // Todoist's priority ring: the API's priority 4 is P1.
            data-priority={task.priority}
            aria-label={`${text.complete}: ${title}${settling ? `, ${text.updating}` : ""}`}
            disabled={busy || settling}
            onClick={() => complete(task)}
          >
            {settling ? (
              <PendingMark language={language} />
            ) : (
              <Check size={13} />
            )}
          </button>
        ) : (
          // A task Plan does not list, or another day's, keeps its title in line.
          <span className="plus-checkbox-slot" aria-hidden="true" />
        )}
        <div className="plus-focus-block-content">
          <div className="plus-focus-block-top">
            {done ? (
              // The planning panel needs an open task; Tasks' own dialog can reopen this one.
              <button
                className="plus-focus-title"
                onClick={() => onOpenTask?.(taskId)}
              >
                {title}
              </button>
            ) : task ? (
              <button
                className="plus-focus-title"
                onClick={() => editTask(task)}
              >
                {title}
              </button>
            ) : (
              <span className="plus-focus-title">{title}</span>
            )}
            {status && (
              <span
                className={`plus-focus-status ${timer ? "is-current" : ""}`}
              >
                {status}
              </span>
            )}
          </div>
          {outcome && outcome.id !== taskId && (
            <span
              className="plus-focus-parent"
              aria-label={language === "zh" ? "父任务" : "Parent task"}
              title={parentPath}
            >
              {displayedTitle(outcome.title)}
            </span>
          )}
          {!task && known?.parentTitle && (
            <span className="plus-focus-parent">
              {displayedTitle(known.parentTitle)}
            </span>
          )}
          {/* The card's one time number: what is logged, ticking while its session runs. */}
          <div className="plus-focus-block-footer">
            <span className="plus-focus-estimate">
              {minutes ? text.est(formattedMinutes(minutes)) : text.unknown}
            </span>
            {records && (
              <>
                <span aria-hidden="true">·</span>
                <FocusLogged
                  taskId={taskId}
                  title={title}
                  date={date}
                  records={records}
                  session={session}
                  area={recordArea(taskId, plan, known, records)}
                  timezone={plan.timezone}
                  language={language}
                  busy={busy}
                  pending={pending}
                  actions={actions}
                  write={writeRecord}
                />
              </>
            )}
          </div>
        </div>
        {task && running && (
          <div className="plus-focus-timer-controls">
            <button
              className="plus-focus-timer-action is-primary"
              aria-label={`${text[timerAction]}: ${title}`}
              disabled={busy || settling || Boolean(focus.timer && !timer)}
              onClick={() => onTimer(timerAction, taskId)}
            >
              {timer?.status === "running" ? (
                <Pause size={17} />
              ) : (
                <Play size={17} />
              )}
              {text[timerAction]}
            </button>
            {timer && (
              <button
                className="plus-focus-timer-action"
                aria-label={`${text.stop}: ${title}`}
                disabled={busy || settling}
                onClick={() => onTimer("stop", taskId)}
              >
                <Square size={13} />
                {language === "zh" ? "结束计时" : "Stop"}
              </button>
            )}
          </div>
        )}
      </article>
    </li>
  );
}
