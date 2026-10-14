import type { ReactNode } from "react";
import {
  DragDropProvider,
  DragOverlay,
  useDraggable,
  useDroppable,
} from "@dnd-kit/react";
import { GripVertical, X } from "lucide-react";
import { displayedTitle, formattedMinutes } from "./domain";
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
  plan: PlanState;
  days: FlowDayPlan[];
  flowTasks: FocusState["flowTasks"];
  timer?: FocusState["timer"];
  currentDate: string;
  language: Language;
  busy: boolean;
  actions: PlusActions;
  run: (operation: () => Promise<void>) => Promise<boolean>;
  editTask: (task: PlanningTask) => void;
  onOpenFocus: (date: string) => void;
  children: ReactNode;
}

export function WeekPlanner(props: Props) {
  const {
    plan,
    days,
    flowTasks,
    timer,
    currentDate,
    language,
    busy,
    actions,
    run,
    editTask,
    onOpenFocus,
    children,
  } = props;
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const text = words(language);
  return (
    <DragDropProvider
      onDragEnd={(event) => {
        if (event.canceled) return;
        const source = event.operation.source?.data as
          { taskId?: string; sourceDate?: string } | undefined;
        const target = event.operation.target?.data as
          { date?: string; beforeId?: string } | undefined;
        const destination = days.find((day) => day.date === target?.date);
        if (
          !source?.taskId ||
          !destination ||
          source.taskId === target?.beforeId
        )
          return;
        const taskId = source.taskId;
        void run(() =>
          actions.moveTaskToDay(
            taskId,
            days.find((day) => day.date === source.sourceDate),
            destination,
            target?.beforeId,
          ),
        );
      }}
    >
      <div className="plus-week-layout">
        <aside
          className="plus-outcome-pool"
          aria-label={language === "zh" ? "目标与步骤" : "Outcomes and steps"}
        >
          {children}
        </aside>
        <section
          className="plus-week-planner"
          aria-label={language === "zh" ? "本周安排" : "Weekly schedule"}
        >
          <div className="plus-week-heading">
            <strong>{language === "zh" ? "本周安排" : "This week"}</strong>
            <span>
              {language === "zh"
                ? "拖到某天 · 不改变 Todoist 日期"
                : "Drag to a day · Todoist dates stay as they are"}
            </span>
          </div>
          <div className="plus-week-columns">
            {days.map((day) => (
              <DayColumn
                key={day.date}
                day={day}
                plan={plan}
                flowTasks={flowTasks}
                timer={timer}
                today={currentDate}
                language={language}
                busy={busy}
                editTask={editTask}
                onOpenFocus={onOpenFocus}
                remove={(id) =>
                  void run(() =>
                    actions.updateQueue(
                      day.taskIds.filter((taskId) => taskId !== id),
                      day,
                    ),
                  )
                }
              />
            ))}
          </div>
        </section>
      </div>
      <DragOverlay dropAnimation={null}>
        {(source) => {
          const taskId = source.data?.taskId as string | undefined;
          const task = taskId ? byId.get(taskId) : undefined;
          const local = taskId ? flowTasks[taskId] : undefined;
          return (
            <div className="plus-week-drag-preview">
              {task && (
                <TaskBreadcrumb
                  task={task}
                  tasks={plan.tasks}
                  language={language}
                />
              )}
              <strong>
                {displayedTitle(task?.title ?? local?.title ?? text.local)}
              </strong>
            </div>
          );
        }}
      </DragOverlay>
    </DragDropProvider>
  );
}

function DayColumn({
  day,
  plan,
  flowTasks,
  timer,
  today,
  language,
  busy,
  editTask,
  onOpenFocus,
  remove,
}: {
  day: FlowDayPlan;
  plan: PlanState;
  flowTasks: FocusState["flowTasks"];
  timer?: FocusState["timer"];
  today: string;
  language: Language;
  busy: boolean;
  editTask: Props["editTask"];
  onOpenFocus: Props["onOpenFocus"];
  remove: (id: string) => void;
}) {
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const ids = day.taskIds.filter((id) => !day.completedTaskIds.includes(id));
  const minutes = ids.reduce(
    (total, id) =>
      total +
      (byId.get(id)?.estimatedMinutes ?? flowTasks[id]?.estimatedMinutes ?? 0),
    0,
  );
  const unknown = ids.filter(
    (id) =>
      (byId.get(id)?.estimatedMinutes ?? flowTasks[id]?.estimatedMinutes) ===
      undefined,
  ).length;
  const { ref, isDropTarget } = useDroppable({
    id: `day:${day.date}`,
    accept: "plus-step",
    collisionPriority: 1,
    disabled: busy,
    data: { date: day.date },
  });
  const date = new Date(`${day.date}T12:00:00Z`);
  return (
    <section
      className={`plus-week-day ${day.date === today ? "is-today" : ""} ${isDropTarget ? "is-over" : ""}`}
      data-date={day.date}
    >
      <button
        className="plus-week-day-heading"
        onClick={() => onOpenFocus(day.date)}
        aria-label={`${language === "zh" ? "专注" : "Focus"}: ${day.date}`}
      >
        <span>
          {new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
            weekday: "short",
            timeZone: "UTC",
          }).format(date)}
        </span>
        <strong>{date.getUTCDate()}</strong>
        <small>
          {minutes ? formattedMinutes(minutes) : "—"}
          {unknown ? ` + ${unknown} ?` : ""}
        </small>
      </button>
      <div ref={ref} className="plus-week-day-body">
        {ids.map((id) => (
          <DayStep
            key={id}
            id={id}
            day={day}
            task={byId.get(id)}
            tasks={plan.tasks}
            local={flowTasks[id]}
            language={language}
            busy={busy}
            timing={timer?.taskId === id && timer.flowDate === day.date}
            editTask={editTask}
            remove={remove}
          />
        ))}
        <DayEnd
          date={day.date}
          busy={busy}
          empty={!ids.length}
          language={language}
        />
      </div>
    </section>
  );
}

function DayStep({
  id,
  day,
  task,
  tasks,
  local,
  language,
  busy,
  timing,
  editTask,
  remove,
}: {
  id: string;
  day: FlowDayPlan;
  task?: PlanningTask;
  tasks: PlanningTask[];
  local?: FocusState["flowTasks"][string];
  language: Language;
  busy: boolean;
  timing: boolean;
  editTask: Props["editTask"];
  remove: (id: string) => void;
}) {
  const title = displayedTitle(
    task?.title ?? local?.title ?? words(language).local,
  );
  const { ref, handleRef, isDragSource } = useDraggable({
    id: `day-step:${day.date}:${id}`,
    type: "plus-step",
    disabled: busy || timing,
    data: { taskId: id, sourceDate: day.date },
  });
  const { ref: dropRef, isDropTarget } = useDroppable({
    id: `before:${day.date}:${id}`,
    accept: "plus-step",
    disabled: busy,
    collisionPriority: 2,
    data: { date: day.date, beforeId: id },
  });
  const estimate = task?.estimatedMinutes ?? local?.estimatedMinutes;
  return (
    <div
      ref={(element) => {
        ref(element);
        dropRef(element);
      }}
      className={`plus-week-step ${isDragSource ? "is-dragging" : ""} ${isDropTarget && !isDragSource ? "is-insert" : ""}`}
      data-task-id={id}
    >
      <div className="plus-week-step-tools">
        <button
          ref={handleRef}
          className="plus-week-handle"
          disabled={busy || timing}
          title={
            timing
              ? language === "zh"
                ? "先结束当前计时再移动"
                : "Stop the current session before moving this step"
              : undefined
          }
          aria-label={`${language === "zh" ? "拖动安排" : "Drag to schedule"}: ${title}`}
        >
          <GripVertical size={13} />
        </button>
        <span>{estimate === undefined ? "?" : formattedMinutes(estimate)}</span>
        <button
          className="plus-week-remove"
          disabled={busy || timing}
          onClick={() => remove(id)}
          aria-label={`${language === "zh" ? "移出日期" : "Remove from day"}: ${title}`}
        >
          <X size={12} />
        </button>
      </div>
      {task && <TaskBreadcrumb task={task} tasks={tasks} language={language} />}
      <button
        className="plus-week-step-title"
        disabled={!task}
        onClick={() => task && editTask(task)}
      >
        {title}
      </button>
    </div>
  );
}

function DayEnd({
  date,
  busy,
  empty,
  language,
}: {
  date: string;
  busy: boolean;
  empty: boolean;
  language: Language;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `day-end:${date}`,
    accept: "plus-step",
    disabled: busy,
    collisionPriority: 2,
    data: { date },
  });
  return (
    <div
      ref={ref}
      className={`plus-week-day-end ${isDropTarget ? "is-over" : ""}`}
    >
      {empty ? (language === "zh" ? "拖入步骤" : "Drop a step") : "+"}
    </div>
  );
}
