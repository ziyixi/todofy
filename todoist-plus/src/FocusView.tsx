import {
  DragDropProvider,
  DragOverlay,
  useDraggable,
  useDroppable,
} from "@dnd-kit/react";
import { GripVertical, Plus } from "lucide-react";
import { useState, type ComponentProps } from "react";
import { displayedTitle, executionChoices, formattedMinutes } from "./domain";
import { FocusBlock } from "./FocusBlock";
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
  focus: FocusState;
  days: FlowDayPlan[];
  today: string;
  onDateChange: (date: string) => void;
  language: Language;
  busy: boolean;
  run: (operation: () => Promise<void>) => Promise<boolean>;
  actions: PlusActions;
  editTask: (task: PlanningTask) => void;
  addFocus: (id: string) => void;
  complete: (task: PlanningTask) => void;
}
type DragEnd = NonNullable<
  ComponentProps<typeof DragDropProvider>["onDragEnd"]
>;

function DayTab({
  day,
  selected,
  today,
  language,
  busy,
  onSelect,
}: {
  day: FlowDayPlan;
  selected: boolean;
  today: string;
  language: Language;
  busy: boolean;
  onSelect: () => void;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `focus-day:${day.date}`,
    type: "day",
    accept: "plus-step",
    disabled: busy,
    data: { date: day.date },
    collisionPriority: 1,
  });
  const date = new Date(`${day.date}T12:00:00Z`);
  const label = new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
    weekday: "short",
    timeZone: "UTC",
  }).format(date);
  const count = day.taskIds.filter(
    (id) => !day.completedTaskIds.includes(id),
  ).length;
  return (
    <button
      ref={ref}
      type="button"
      className={`plus-focus-day ${selected ? "is-selected" : ""} ${isDropTarget ? "is-drop-target" : ""}`}
      aria-pressed={selected}
      data-date={day.date}
      aria-label={`${label} ${day.date}${day.date === today ? ` · ${words(language).today}` : ""}`}
      onClick={onSelect}
      disabled={busy}
    >
      <span>{label}</span>
      <strong className={day.date === today ? "is-today" : ""}>
        {date.getUTCDate()}
      </strong>
      <small>{count || "–"}</small>
    </button>
  );
}

function EndDrop({
  date,
  empty,
  busy,
  language,
}: {
  date: string;
  empty: boolean;
  busy: boolean;
  language: Language;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `focus-end:${date}`,
    type: "day",
    accept: "plus-step",
    disabled: busy,
    data: { date },
    collisionPriority: 1,
  });
  return (
    <li
      ref={ref}
      className={`plus-focus-end ${empty ? "is-empty" : ""} ${isDropTarget ? "is-drop-target" : ""}`}
    >
      <Plus size={15} />
      {language === "zh" ? "把小步骤拖到这里" : "Drop a small step here"}
    </li>
  );
}

function AvailableStep({
  task,
  plan,
  language,
  busy,
  editTask,
  addFocus,
}: {
  task: PlanningTask;
  plan: PlanState;
  language: Language;
  busy: boolean;
  editTask: (task: PlanningTask) => void;
  addFocus: (id: string) => void;
}) {
  const { ref, handleRef, isDragSource } = useDraggable({
    id: `focus-choice:${task.id}`,
    type: "plus-step",
    disabled: busy,
    data: { taskId: task.id },
  });
  return (
    <li
      ref={ref}
      className={`plus-focus-available ${isDragSource ? "is-dragging" : ""}`}
    >
      <button
        ref={handleRef}
        className="plus-focus-grip"
        disabled={busy}
        aria-label={`${language === "zh" ? "拖动步骤" : "Drag step"}: ${displayedTitle(task.title)}`}
      >
        <GripVertical size={17} />
      </button>
      <button className="plus-task-main" onClick={() => editTask(task)}>
        <TaskBreadcrumb task={task} tasks={plan.tasks} language={language} />
        <span>{displayedTitle(task.title)}</span>
      </button>
      {task.estimatedMinutes !== undefined && (
        <span className="plus-muted">
          {formattedMinutes(task.estimatedMinutes)}
        </span>
      )}
      <button
        className="plus-icon plus-focus-add"
        disabled={busy}
        onClick={() => addFocus(task.id)}
        aria-label={`${language === "zh" ? "加入这一天" : "Add to this day"}: ${displayedTitle(task.title)}`}
        title={language === "zh" ? "加入这一天" : "Add to this day"}
      >
        <Plus size={16} />
      </button>
    </li>
  );
}

export function FocusView({
  plan,
  focus,
  days,
  today,
  onDateChange,
  language,
  busy,
  run,
  actions,
  editTask,
  addFocus,
  complete,
}: Props) {
  const text = words(language);
  const [chooser, setChooser] = useState(false);
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const queue = focus.taskIds
    .filter((id) => !focus.completedTaskIds.includes(id))
    .map((id): PlanningTask => {
      const task = byId.get(id);
      if (task) return task;
      let missingTitle = text.missingTask;
      if (id.startsWith("__flowday_misc__"))
        missingTitle = language === "zh" ? "杂项时间" : "Miscellaneous time";
      return {
        id,
        title: focus.flowTasks[id]?.title ?? missingTitle,
        estimatedMinutes: focus.flowTasks[id]?.estimatedMinutes,
        parentId: "",
        projectId: "",
        labels: [],
        area: "unassigned",
        stage: "none",
        bet: false,
        deadline: "",
        leadDays: 0,
        due: "",
        etag: "",
        mustStart: false,
        missingLead: false,
      };
    });
  const choices = executionChoices(plan.tasks).filter(
    (task) => !focus.taskIds.includes(task.id),
  );
  const minutesOf = (task: PlanningTask) =>
    focus.estimates[task.id] ?? task.estimatedMinutes ?? 0;
  const totalMinutes = queue.reduce((sum, task) => sum + minutesOf(task), 0);
  const unknown = queue.filter((task) => !minutesOf(task)).length;
  let stepLabel = language === "zh" ? "个步骤" : "steps";
  if (language === "en" && queue.length === 1) stepLabel = "step";
  const selectedDay = days.find((day) => day.date === focus.date) ?? focus;
  const move: DragEnd = ({ canceled, operation }) => {
    if (canceled || busy || !operation.source || !operation.target) return;
    const source = operation.source.data as {
      taskId: string;
      sourceDate?: string;
    };
    const target = operation.target.data as { date: string; beforeId?: string };
    if (!source.taskId || !target.date || source.taskId === target.beforeId)
      return;
    const sourceDay = days.find((day) => day.date === source.sourceDate);
    const targetDay = days.find((day) => day.date === target.date);
    if (!targetDay) return;
    void run(() =>
      actions.moveTaskToDay(
        source.taskId,
        sourceDay,
        targetDay,
        target.beforeId,
      ),
    );
  };
  let offset = 0;
  return (
    <DragDropProvider onDragEnd={move}>
      <nav
        className="plus-focus-week"
        aria-label={language === "zh" ? "选择专注日期" : "Choose focus day"}
      >
        {days.map((day) => (
          <DayTab
            key={day.date}
            day={day}
            selected={day.date === focus.date}
            today={today}
            language={language}
            busy={busy}
            onSelect={() => onDateChange(day.date)}
          />
        ))}
      </nav>
      {focus.date !== today && (
        <p className="plus-focus-timing-note">
          {language === "zh"
            ? "切到今天开始计时。"
            : "Switch to today to start timing."}
          <button
            className="plus-text-button"
            onClick={() => onDateChange(today)}
          >
            {text.today}
          </button>
        </p>
      )}
      <div className="plus-focus-summary">
        <strong>{formattedMinutes(totalMinutes)}</strong>
        <span>
          {queue.length} {stepLabel}
        </span>
        {unknown > 0 && (
          <span>
            {unknown} {text.unknown.toLowerCase()}
          </span>
        )}
        <button
          className="plus-button"
          aria-expanded={chooser}
          onClick={() => setChooser(!chooser)}
        >
          <Plus size={15} />
          {text.choose}
        </button>
      </div>
      <p className="plus-focus-hint">
        {language === "zh"
          ? "拖动调整顺序或移到其他日期。这里安排用时，不改 Todoist 日期。"
          : "Drag to reorder or move to another day. This plans time without changing Todoist dates."}
      </p>
      <ol
        className="plus-focus-stack"
        aria-label={language === "zh" ? "当天步骤" : "Day steps"}
      >
        {queue.map((task, index) => {
          const start = offset;
          offset += minutesOf(task);
          return (
            <FocusBlock
              key={task.id}
              task={task}
              plan={plan}
              focus={focus}
              day={selectedDay}
              language={language}
              today={today}
              busy={busy}
              actions={actions}
              run={run}
              editTask={editTask}
              complete={complete}
              native={byId.has(task.id)}
              index={index}
              queueIds={queue.map((item) => item.id)}
              offset={start}
              minutes={minutesOf(task)}
            />
          );
        })}
        <EndDrop
          date={focus.date}
          empty={!queue.length}
          busy={busy}
          language={language}
        />
      </ol>
      {(chooser || !queue.length) && (
        <section className="plus-focus-choices">
          <div className="plus-section-title">
            <h2>{text.available}</h2>
          </div>
          <ul className="plus-task-list">
            {choices.map((task) => (
              <AvailableStep
                key={task.id}
                task={task}
                plan={plan}
                language={language}
                busy={busy}
                editTask={editTask}
                addFocus={addFocus}
              />
            ))}
          </ul>
          {!choices.length && (
            <p className="plus-empty">{text.emptyCandidate}</p>
          )}
        </section>
      )}
      {focus.completedTaskIds.length > 0 && (
        <p className="plus-footer-note">
          {focus.completedTaskIds.length}{" "}
          {language === "zh" ? "已完成" : "completed"}
        </p>
      )}
      <DragOverlay dropAnimation={null}>
        {(source) => {
          const taskId = source.data?.taskId as string | undefined;
          const task = taskId ? byId.get(taskId) : undefined;
          return (
            <div className="plus-focus-drag-preview">
              {task && (
                <TaskBreadcrumb
                  task={task}
                  tasks={plan.tasks}
                  language={language}
                />
              )}
              <strong>
                {displayedTitle(
                  task?.title ??
                    (taskId ? focus.flowTasks[taskId]?.title : undefined) ??
                    text.local,
                )}
              </strong>
            </div>
          );
        }}
      </DragOverlay>
    </DragDropProvider>
  );
}
