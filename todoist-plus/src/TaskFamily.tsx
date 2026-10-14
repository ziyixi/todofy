import { useState } from "react";
import { useDraggable } from "@dnd-kit/react";
import { ChevronDown, ChevronRight, GripVertical, Star } from "lucide-react";
import { displayedTitle, formattedMinutes, taskAncestors } from "./domain";
import { words } from "./i18n";
import type {
  FlowDayPlan,
  FocusState,
  Language,
  PlanningTask,
  PlusActions,
} from "./model";

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
      aria-label={language === "zh" ? "所属任务" : "Parent task"}
      title={parents.map((parent) => displayedTitle(parent.title)).join(" › ")}
    >
      {parents.map((parent) => displayedTitle(parent.title)).join(" › ")}
    </small>
  );
}

interface Props {
  task: PlanningTask;
  tasks: PlanningTask[];
  days: FlowDayPlan[];
  currentDate: string;
  language: Language;
  busy: boolean;
  timer?: FocusState["timer"];
  actions: PlusActions;
  run: (operation: () => Promise<void>) => Promise<boolean>;
  editTask: (task: PlanningTask) => void;
  depth?: number;
  familyStage?: PlanningTask["stage"];
}

export function TaskFamily({
  task,
  tasks,
  days,
  currentDate,
  language,
  busy,
  timer,
  actions,
  run,
  editTask,
  depth = 0,
  familyStage = task.stage,
}: Props) {
  const text = words(language);
  const children = tasks.filter((child) => child.parentId === task.id);
  const shownChildren = children.filter(
    (child) => child.stage === "none" || child.stage === familyStage,
  );
  const [open, setOpen] = useState(depth === 0 && task.stage === "committed");
  const leaf = children.length === 0;
  const timing = timer?.taskId === task.id;
  const { ref, handleRef, isDragSource } = useDraggable({
    id: `pool:${depth}:${task.id}`,
    type: "plus-step",
    disabled: busy || !leaf || timing,
    data: { taskId: task.id },
  });
  const scheduled = days.filter(
    (day) =>
      day.taskIds.includes(task.id) && !day.completedTaskIds.includes(task.id),
  );
  return (
    <li className={`plus-family ${isDragSource ? "is-dragging" : ""}`}>
      <div ref={ref} className="plus-family-row" data-task-id={task.id}>
        {leaf ? (
          <button
            ref={handleRef}
            className="plus-family-handle"
            aria-label={`${language === "zh" ? "拖动安排" : "Drag to schedule"}: ${displayedTitle(task.title)}`}
            disabled={busy || timing}
            title={
              timing
                ? language === "zh"
                  ? "先结束当前计时再移动"
                  : "Stop the current session before moving this step"
                : undefined
            }
          >
            <GripVertical size={14} />
          </button>
        ) : (
          <button
            className="plus-family-handle"
            aria-label={`${open ? text.close : text.chooseStep}: ${displayedTitle(task.title)}`}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
        )}
        <button className="plus-family-title" onClick={() => editTask(task)}>
          {depth === 0 && (
            <TaskBreadcrumb task={task} tasks={tasks} language={language} />
          )}
          <span>{displayedTitle(task.title)}</span>
          {!leaf && (
            <small>
              {children.length} {text.steps.toLowerCase()}
            </small>
          )}
          {leaf && (
            <small>
              {task.estimatedMinutes === undefined
                ? text.unknown
                : formattedMinutes(task.estimatedMinutes)}
              {scheduled.length > 0 && (
                <>
                  {" "}
                  ·{" "}
                  {scheduled
                    .map((day) =>
                      new Intl.DateTimeFormat(
                        language === "zh" ? "zh-CN" : "en",
                        { weekday: "short", timeZone: "UTC" },
                      ).format(new Date(`${day.date}T12:00:00Z`)),
                    )
                    .join(", ")}
                </>
              )}
            </small>
          )}
        </button>
        {depth === 0 && (
          <div className="plus-family-controls">
            <button
              className={`plus-family-bet ${task.bet ? "active" : ""}`}
              aria-label={`${task.bet ? text.unbet : text.bet}: ${displayedTitle(task.title)}`}
              disabled={busy}
              onClick={() =>
                void run(() => actions.updateTask(task, { bet: !task.bet }))
              }
            >
              <Star size={14} fill={task.bet ? "currentColor" : "none"} />
            </button>
            <select
              aria-label={`${text.mode}: ${displayedTitle(task.title)}`}
              value={task.stage}
              disabled={busy}
              onChange={(event) =>
                void run(() =>
                  actions.updateTask(task, {
                    stage: event.target.value as PlanningTask["stage"],
                  }),
                )
              }
            >
              {(["none", "monthly", "weekly", "committed"] as const).map(
                (stage) => (
                  <option key={stage} value={stage}>
                    {text[stage]}
                  </option>
                ),
              )}
            </select>
          </div>
        )}
        {leaf && (
          <select
            className="plus-family-schedule"
            aria-label={`${language === "zh" ? "安排日期" : "Schedule day"}: ${displayedTitle(task.title)}`}
            value=""
            disabled={busy || timing}
            onChange={(event) => {
              const target = days.find(
                (day) => day.date === event.target.value,
              );
              if (target)
                void run(() =>
                  actions.moveTaskToDay(task.id, undefined, target),
                );
            }}
          >
            <option value="">
              {language === "zh" ? "安排…" : "Schedule…"}
            </option>
            {days.map((day) => (
              <option key={day.date} value={day.date}>
                {day.date === currentDate
                  ? text.today
                  : new Intl.DateTimeFormat(
                      language === "zh" ? "zh-CN" : "en",
                      { weekday: "short", timeZone: "UTC" },
                    ).format(new Date(`${day.date}T12:00:00Z`))}
              </option>
            ))}
          </select>
        )}
      </div>
      {task.estimatedMinutes !== undefined &&
        task.estimatedMinutes >= 120 &&
        leaf && <p className="plus-family-long">{text.longStep}</p>}
      {open && shownChildren.length > 0 && (
        <ul className="plus-family-children">
          {shownChildren.map((child) => (
            <TaskFamily
              key={child.id}
              task={child}
              tasks={tasks}
              days={days}
              currentDate={currentDate}
              language={language}
              busy={busy}
              timer={timer}
              actions={actions}
              run={run}
              editTask={editTask}
              depth={depth + 1}
              familyStage={familyStage}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
