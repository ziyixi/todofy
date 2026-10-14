import { useState, type CSSProperties } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/react";
import { ChevronLeft, ChevronRight, GripVertical, X } from "lucide-react";
import { displayedTitle, formattedMinutes } from "./domain";
import { outcomeArea, outcomeColor, outcomeForTask } from "./planning-outcomes";
import { words } from "./i18n";
import type {
  FlowDayPlan,
  FocusState,
  Language,
  PlanState,
  PlanningTask,
} from "./model";
interface Props {
  plan: PlanState;
  days: FlowDayPlan[];
  flowTasks: FocusState["flowTasks"];
  timer?: FocusState["timer"];
  currentDate: string;
  language: Language;
  busy: boolean;
  editTask: (task: PlanningTask) => void;
  onWeekChange: (week: string) => void;
  onRemove: (day: FlowDayPlan, id: string) => void;
}
export function PlanningCalendar({
  plan,
  days,
  flowTasks,
  timer,
  currentDate,
  language,
  busy,
  editTask,
  onWeekChange,
  onRemove,
}: Props) {
  const [selectedDate, setSelectedDate] = useState(currentDate);
  const dayIndex = Math.max(
    0,
    days.findIndex(
      (day) =>
        day.date ===
        (days.some((day) => day.date === selectedDate)
          ? selectedDate
          : currentDate),
    ),
  );
  const windowStart = Math.min(
    Math.max(0, dayIndex - 1),
    Math.max(0, days.length - 3),
  );
  const week = days[0]?.date ?? plan.week;
  const range = new Intl.DateTimeFormat(locale(language), {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).formatRange(dayDate(week), dayDate(days.at(-1)?.date ?? week));
  function changeWeek(direction: number) {
    const date = dayDate(week);
    date.setUTCDate(date.getUTCDate() + direction * 7);
    onWeekChange(date.toISOString().slice(0, 10));
  }
  return (
    <section
      className="planning-calendar"
      aria-label={language === "zh" ? "日期安排" : "Week schedule"}
    >
      <header className="planning-calendar-heading">
        <nav aria-label={language === "zh" ? "选择周" : "Choose week"}>
          <button
            aria-label={language === "zh" ? "上一周" : "Previous week"}
            onClick={() => changeWeek(-1)}
          >
            <ChevronLeft size={18} />
          </button>
          <strong>{range}</strong>
          <button
            aria-label={language === "zh" ? "下一周" : "Next week"}
            onClick={() => changeWeek(1)}
          >
            <ChevronRight size={18} />
          </button>
          <button
            className="planning-current-week"
            disabled={week === plan.week}
            onClick={() => onWeekChange(plan.week)}
          >
            {language === "zh" ? "回本周" : "This week"}
          </button>
        </nav>
        <span>
          {language === "zh" ? "把小步骤拖到某天" : "Drag steps into a day"}
        </span>
      </header>
      <div
        className="planning-compact-days"
        role="tablist"
        aria-label={language === "zh" ? "选择日期" : "Choose day"}
      >
        {days.map((day, index) => (
          <DatePicker
            key={day.date}
            day={day}
            selected={index === dayIndex}
            language={language}
            busy={busy}
            onSelect={() => setSelectedDate(day.date)}
          />
        ))}
      </div>
      <div className="planning-calendar-columns">
        {days.map((day, index) => (
          <CalendarDay
            key={day.date}
            day={day}
            plan={plan}
            flowTasks={flowTasks}
            timer={timer}
            today={currentDate}
            selected={index === dayIndex}
            inWindow={index >= windowStart && index < windowStart + 3}
            language={language}
            busy={busy}
            editTask={editTask}
            onSelect={() => setSelectedDate(day.date)}
            onRemove={(id) => onRemove(day, id)}
          />
        ))}
      </div>
    </section>
  );
}

function DatePicker({
  day,
  selected,
  language,
  busy,
  onSelect,
}: {
  day: FlowDayPlan;
  selected: boolean;
  language: Language;
  busy: boolean;
  onSelect: () => void;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `week-picker:${day.date}`,
    accept: "planning-step",
    disabled: busy,
    collisionPriority: 2,
    data: { date: day.date },
  });
  return (
    <button
      ref={ref}
      role="tab"
      aria-label={`${language === "zh" ? "显示" : "Show"} ${day.date}`}
      aria-selected={selected}
      className={isDropTarget ? "is-over" : ""}
      onClick={onSelect}
    >
      <span>{shortDay(day.date, language)}</span>
      <strong>{dayDate(day.date).getUTCDate()}</strong>
    </button>
  );
}

function CalendarDay({
  day,
  plan,
  flowTasks,
  timer,
  today,
  selected,
  inWindow,
  language,
  busy,
  editTask,
  onSelect,
  onRemove,
}: {
  day: FlowDayPlan;
  plan: PlanState;
  flowTasks: FocusState["flowTasks"];
  timer?: FocusState["timer"];
  today: string;
  selected: boolean;
  inWindow: boolean;
  language: Language;
  busy: boolean;
  editTask: Props["editTask"];
  onSelect: () => void;
  onRemove: (id: string) => void;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `week-day:${day.date}`,
    accept: "planning-step",
    disabled: busy,
    collisionPriority: 1,
    data: { date: day.date },
  });
  const ids = day.taskIds.filter((id) => !day.completedTaskIds.includes(id));
  const estimate = (id: string) =>
    plan.tasks.find((task) => task.id === id)?.estimatedMinutes ??
    flowTasks[id]?.estimatedMinutes;
  const minutes = ids.reduce((sum, id) => sum + (estimate(id) ?? 0), 0);
  const unknown = ids.filter((id) => estimate(id) === undefined).length;
  return (
    <section
      className={`planning-calendar-day ${day.date === today ? "is-today" : ""} ${selected ? "is-selected" : ""} ${inWindow ? "is-window" : ""} ${isDropTarget ? "is-over" : ""}`}
      data-date={day.date}
    >
      <button
        className="planning-day-heading"
        onClick={onSelect}
        aria-label={`${language === "zh" ? "选择日期" : "Select day"}: ${day.date}`}
      >
        <span>{shortDay(day.date, language)}</span>
        <strong>{dayDate(day.date).getUTCDate()}</strong>
        <small>
          {minutes ? formattedMinutes(minutes) : "—"}
          {unknown ? ` + ${unknown} ?` : ""}
        </small>
      </button>
      <div ref={ref} className="planning-day-body">
        {ids.map((id) => (
          <CalendarStep
            key={id}
            id={id}
            day={day}
            plan={plan}
            flowTask={flowTasks[id]}
            timer={timer}
            language={language}
            busy={busy}
            editTask={editTask}
            onRemove={onRemove}
          />
        ))}
        <EndDrop
          date={day.date}
          empty={!ids.length}
          language={language}
          busy={busy}
        />
      </div>
    </section>
  );
}

function CalendarStep({
  id,
  day,
  plan,
  flowTask,
  timer,
  language,
  busy,
  editTask,
  onRemove,
}: {
  id: string;
  day: FlowDayPlan;
  plan: PlanState;
  flowTask?: FocusState["flowTasks"][string];
  timer?: FocusState["timer"];
  language: Language;
  busy: boolean;
  editTask: Props["editTask"];
  onRemove: (id: string) => void;
}) {
  const task = plan.tasks.find((task) => task.id === id);
  const outcome = task
    ? outcomeForTask(task, plan.tasks, plan.managedLabels)
    : undefined;
  const timing = timer?.taskId === id && timer.flowDate === day.date;
  const { ref, handleRef, isDragSource } = useDraggable({
    id: `week-step:${day.date}:${id}`,
    type: "planning-step",
    disabled: busy || timing,
    data: { taskId: id, sourceDate: day.date },
  });
  const { ref: dropRef, isDropTarget } = useDroppable({
    id: `week-before:${day.date}:${id}`,
    accept: "planning-step",
    disabled: busy,
    collisionPriority: 2,
    data: { date: day.date, beforeId: id },
  });
  const title = taskTitle(id, task?.title ?? flowTask?.title, language);
  const minutes = task?.estimatedMinutes ?? flowTask?.estimatedMinutes;
  const parent = outcome
    ? outcome.id === id
      ? outcomeArea(outcome, plan.tasks, language)
      : displayedTitle(outcome.title)
    : words(language).local;
  return (
    <article
      ref={(element) => {
        ref(element);
        dropRef(element);
      }}
      className={`planning-calendar-step ${isDragSource ? "is-dragging" : ""} ${isDropTarget && !isDragSource ? "is-insert" : ""}`}
      data-task-id={id}
      style={
        {
          "--outcome-color": outcome
            ? outcomeColor(outcome)
            : "var(--plus-muted)",
        } as CSSProperties
      }
    >
      <div className="planning-calendar-step-top">
        <button
          ref={handleRef}
          className="planning-drag-handle"
          disabled={busy || timing}
          title={
            timing
              ? language === "zh"
                ? "先结束当前计时再移动"
                : "Stop the current session before moving this step"
              : undefined
          }
          aria-label={`${language === "zh" ? "拖动已安排步骤" : "Drag scheduled step"}: ${title}`}
        >
          <GripVertical size={14} />
        </button>
        <button
          className="planning-step-title"
          disabled={!task}
          onClick={() => task && editTask(task)}
        >
          {title}
        </button>
        <button
          className="planning-step-remove"
          disabled={busy || timing}
          aria-label={`${language === "zh" ? "移出日期" : "Remove from"} ${day.date}: ${title}`}
          onClick={() => onRemove(id)}
        >
          <X size={13} />
        </button>
      </div>
      <div className="planning-calendar-step-meta">
        <span title={parent}>{parent}</span>
        <strong>
          {minutes === undefined ? "?" : formattedMinutes(minutes)}
        </strong>
      </div>
    </article>
  );
}
function EndDrop({
  date,
  empty,
  language,
  busy,
}: {
  date: string;
  empty: boolean;
  language: Language;
  busy: boolean;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `week-end:${date}`,
    accept: "planning-step",
    disabled: busy,
    collisionPriority: 2,
    data: { date },
  });
  return (
    <div
      ref={ref}
      className={`planning-day-end ${isDropTarget ? "is-over" : ""}`}
    >
      {empty ? (language === "zh" ? "拖入步骤" : "Drop a step") : "+"}
    </div>
  );
}
function dayDate(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}
function locale(language: Language): string {
  return language === "zh" ? "zh-CN" : "en";
}
export function shortDay(date: string, language: Language): string {
  return new Intl.DateTimeFormat(locale(language), {
    weekday: "short",
    timeZone: "UTC",
  }).format(dayDate(date));
}
export function taskTitle(
  id: string,
  title: string | undefined,
  language: Language,
): string {
  if (title !== undefined) return displayedTitle(title);
  if (id.startsWith("__flowday_misc__"))
    return language === "zh" ? "杂项时间" : "Miscellaneous time";
  return words(language).missingTask;
}
