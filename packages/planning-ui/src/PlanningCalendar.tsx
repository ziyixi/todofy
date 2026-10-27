import { useState, type CSSProperties } from "react";
import { useDraggable, useDroppable } from "@dnd-kit/react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  X,
} from "lucide-react";
import {
  addDays,
  clockTime,
  displayedTitle,
  formattedMinutes,
  planningWeekStart,
  hasPlanningFlag,
  taskIndex,
} from "./domain";
import { dragHandle } from "./drag-announcements";
import { areaColor, outcomeArea, outcomeForTask } from "./planning-outcomes";
import { pendingStep } from "./plan-updates";
import {
  CompleteTaskButton,
  type CompletePlanningTask,
} from "./CompleteTaskButton";
import { PendingMark } from "./StatusMarks";
import { words } from "./i18n";
import { isoWeek } from "./weekly-review";
import type {
  DayPlan,
  FocusState,
  Language,
  PlanState,
  PlanningTask,
} from "./model";
interface Props {
  plan: PlanState;
  days: DayPlan[];
  /** Titles and estimates of queued tasks Plan's list leaves out. */
  focusTasks: FocusState["tasks"];
  timer?: FocusState["timer"];
  currentDate: string;
  language: Language;
  busy: boolean;
  pending?: ReadonlySet<string>;
  /** The ID of the drag instructions, which every handle names. */
  dragHint: string;
  editTask: (task: PlanningTask) => void;
  completeTask: CompletePlanningTask;
  /** Opens Tasks' own task dialog, where a done step can be reopened. */
  onOpenTask?: (id: string) => void;
  onWeekChange: (week: string) => void;
  onRemove: (day: DayPlan, id: string) => void;
}
export function PlanningCalendar({
  plan,
  days,
  focusTasks,
  timer,
  currentDate,
  language,
  busy,
  pending,
  dragHint,
  editTask,
  completeTask,
  onOpenTask,
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
  const week = days[0]?.date ?? planningWeekStart(plan.week);
  const range = dateFormat(language, "range").formatRange(
    dayDate(week),
    dayDate(days.at(-1)?.date ?? week),
  );
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
            disabled={week === planningWeekStart(plan.week)}
            onClick={() => onWeekChange(planningWeekStart(plan.week))}
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
            focusTasks={focusTasks}
            timer={timer}
            today={currentDate}
            selected={index === dayIndex}
            inWindow={index >= windowStart && index < windowStart + 3}
            language={language}
            busy={busy}
            pending={pending}
            dragHint={dragHint}
            editTask={editTask}
            completeTask={completeTask}
            onOpenTask={onOpenTask}
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
  day: DayPlan;
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
  focusTasks,
  timer,
  today,
  selected,
  inWindow,
  language,
  busy,
  pending,
  dragHint,
  editTask,
  completeTask,
  onOpenTask,
  onSelect,
  onRemove,
}: {
  day: DayPlan;
  plan: PlanState;
  focusTasks: FocusState["tasks"];
  timer?: FocusState["timer"];
  today: string;
  selected: boolean;
  inWindow: boolean;
  language: Language;
  busy: boolean;
  pending?: ReadonlySet<string>;
  dragHint: string;
  editTask: Props["editTask"];
  completeTask: CompletePlanningTask;
  onOpenTask: Props["onOpenTask"];
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
  // The open steps, which the heading's total counts; the steps done from this day stay after them.
  const ids = day.taskIds.filter((id) => !day.completedTaskIds.includes(id));
  const tasks = taskIndex(plan.tasks);
  const estimate = (id: string) =>
    tasks.get(id)?.estimatedMinutes ?? focusTasks[id]?.estimatedMinutes;
  const minutes = ids.reduce((sum, id) => sum + (estimate(id) ?? 0), 0);
  const unknown = ids.filter((id) => {
    const task = tasks.get(id);
    return (
      estimate(id) === undefined && (!task || !hasPlanningFlag(task, "quick"))
    );
  }).length;
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
            focusTask={focusTasks[id]}
            timer={timer}
            language={language}
            busy={busy}
            pending={pending?.has(pendingStep(day.date, id)) ?? false}
            dragHint={dragHint}
            editTask={editTask}
            completeTask={completeTask}
            onRemove={onRemove}
          />
        ))}
        <EndDrop
          date={day.date}
          empty={!ids.length}
          beforeDone={day.completedTaskIds.length > 0}
          language={language}
          busy={busy}
        />
        {day.completedTaskIds.map((id) => (
          <DoneStep
            key={id}
            id={id}
            plan={plan}
            focusTask={focusTasks[id]}
            language={language}
            onOpenTask={onOpenTask}
          />
        ))}
      </div>
    </section>
  );
}

function CalendarStep({
  id,
  day,
  plan,
  focusTask,
  timer,
  language,
  busy,
  pending,
  dragHint,
  editTask,
  completeTask,
  onRemove,
}: {
  id: string;
  day: DayPlan;
  plan: PlanState;
  focusTask?: FocusState["tasks"][string];
  timer?: FocusState["timer"];
  language: Language;
  busy: boolean;
  /** Its move or removal is shown but not yet confirmed. */
  pending: boolean;
  dragHint: string;
  editTask: Props["editTask"];
  completeTask: CompletePlanningTask;
  onRemove: (id: string) => void;
}) {
  const task = taskIndex(plan.tasks).get(id);
  const outcome = task ? outcomeForTask(task, plan.tasks) : undefined;
  const timing = timer?.taskId === id && timer.day === day.date;
  const title = taskTitle(task?.title ?? focusTask?.title, language);
  const { ref, handleRef, isDragSource } = useDraggable({
    id: `week-step:${day.date}:${id}`,
    type: "planning-step",
    disabled: busy || timing || pending,
    data: { taskId: id, sourceDate: day.date, title },
  });
  const { ref: dropRef, isDropTarget } = useDroppable({
    id: `week-before:${day.date}:${id}`,
    accept: "planning-step",
    disabled: busy,
    collisionPriority: 2,
    data: { date: day.date, beforeId: id },
  });
  const minutes = task?.estimatedMinutes ?? focusTask?.estimatedMinutes;
  const time = task?.dueDatetime
    ? clockTime(task.dueDatetime, task.dueTimezone || plan.timezone, language)
    : "";
  const quick = task && hasPlanningFlag(task, "quick");
  // A task Plan does not list names its parent as Tasks' Focus read does.
  const parent = outcome
    ? outcome.id === id
      ? outcomeArea(outcome, plan.tasks, language)
      : displayedTitle(outcome.title)
    : displayedTitle(focusTask?.parentTitle ?? "");
  return (
    <article
      ref={(element) => {
        ref(element);
        dropRef(element);
      }}
      className={`planning-calendar-step ${isDragSource ? "is-dragging" : ""} ${isDropTarget && !isDragSource ? "is-insert" : ""} ${pending ? "is-pending" : ""}`}
      data-task-id={id}
      aria-busy={pending || undefined}
      style={
        {
          // A task Plan does not list shows no colour.
          "--area-color": task
            ? areaColor(task, plan.tasks)
            : "var(--plus-area-none)",
        } as CSSProperties
      }
    >
      <div className="planning-calendar-step-top">
        <button
          ref={handleRef}
          className="planning-drag-handle"
          {...dragHandle(language, dragHint)}
          // A waiting handle stays focusable, so a keyboard reorder keeps focus on the card.
          disabled={busy || timing}
          aria-disabled={pending || undefined}
          title={
            timing
              ? language === "zh"
                ? "先结束当前计时再移动"
                : "Stop the current session before moving this step"
              : undefined
          }
          aria-label={`${language === "zh" ? "拖动已安排步骤" : "Drag scheduled step"}: ${title}${pending ? `, ${words(language).updating}` : ""}`}
        >
          <GripVertical size={14} />
        </button>
        {/* Three lines at most; a day column clips, so the full title is the native tooltip. */}
        <button
          className="planning-step-title"
          title={title}
          disabled={!task}
          onClick={() => task && editTask(task)}
        >
          {title}
        </button>
        {pending && <PendingMark language={language} />}
        {task && (
          <CompleteTaskButton
            task={task}
            language={language}
            disabled={busy || pending}
            onComplete={() => completeTask(task, day.date)}
          />
        )}
        <button
          className="planning-step-remove"
          disabled={busy || timing || pending}
          aria-label={`${language === "zh" ? "移出日期" : "Remove from"} ${day.date}: ${title}`}
          onClick={() => onRemove(id)}
        >
          <X size={13} />
        </button>
      </div>
      <div className="planning-calendar-step-meta">
        <span title={parent}>{parent}</span>
        <strong>
          {time ||
            (quick
              ? words(language).executionQuick
              : minutes === undefined
                ? "?"
                : formattedMinutes(minutes))}
        </strong>
      </div>
    </article>
  );
}
/**
 * A step done from this day's queue. It stays in its day, after the open steps and in their queue
 * order, in Focus's done style: the filled check, the title muted and struck through. It is not
 * dragged, removed or counted in the day's total. The planning panel needs an open task, so its
 * title opens Tasks' own dialog, where it can be reopened. Its title comes from Plan, else from
 * the Focus read that named it, else it is unavailable.
 */
function DoneStep({
  id,
  plan,
  focusTask,
  language,
  onOpenTask,
}: {
  id: string;
  plan: PlanState;
  focusTask?: FocusState["tasks"][string];
  language: Language;
  onOpenTask: Props["onOpenTask"];
}) {
  const tasks = taskIndex(plan.tasks);
  // A repeating step stays open in Plan after a completion; any other done step is not listed.
  const task = tasks.get(id);
  const outcome = task ? outcomeForTask(task, plan.tasks) : undefined;
  // One Plan does not list takes its parent's colour when Plan lists the parent, as in Focus.
  const listedParent = focusTask?.parentId
    ? tasks.get(focusTask.parentId)
    : undefined;
  const title = taskTitle(task?.title ?? focusTask?.title, language);
  const parent = outcome
    ? outcome.id === id
      ? outcomeArea(outcome, plan.tasks, language)
      : displayedTitle(outcome.title)
    : displayedTitle(focusTask?.parentTitle ?? "");
  const minutes = task?.estimatedMinutes ?? focusTask?.estimatedMinutes;
  const color = task
    ? areaColor(task, plan.tasks)
    : listedParent
      ? areaColor(listedParent, plan.tasks)
      : "var(--plus-area-none)";
  // Read before the title, so its name says it is done; the space is outside the hidden text.
  const name = (
    <>
      <span className="plus-sr-only">{`${words(language).completed}:`}</span>{" "}
      {title}
    </>
  );
  return (
    <article
      className="planning-calendar-step is-done"
      data-task-id={id}
      style={{ "--area-color": color } as CSSProperties}
    >
      <div className="planning-calendar-step-top">
        {onOpenTask ? (
          <button
            className="planning-step-title"
            title={title}
            onClick={() => onOpenTask(id)}
          >
            {name}
          </button>
        ) : (
          <span className="planning-step-title" title={title}>
            {name}
          </span>
        )}
        <span className="plus-checkbox is-done" aria-hidden="true">
          <Check size={12} />
        </span>
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
  beforeDone,
  language,
  busy,
}: {
  date: string;
  empty: boolean;
  /** Done steps follow it: after open steps it is a thin band, where a dropped step lands. */
  beforeDone: boolean;
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
      className={`planning-day-end ${isDropTarget ? "is-over" : ""} ${beforeDone && !empty ? "is-before-done" : ""}`}
    >
      {/* A day with steps shows its drop zone only while a step is dragged over it. */}
      {empty && (language === "zh" ? "拖入步骤" : "Drop a step")}
    </div>
  );
}
function dayDate(date: string): Date {
  return new Date(`${date}T12:00:00Z`);
}
const dateStyles = {
  weekday: { weekday: "short" },
  range: { month: "short", day: "numeric", year: "numeric" },
  day: { weekday: "short", month: "short", day: "numeric" },
  dayYear: {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  },
  monthDay: { month: "short", day: "numeric" },
  monthDayYear: { year: "numeric", month: "short", day: "numeric" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;
const dateFormats = new Map<string, Intl.DateTimeFormat>();
/** Formatters are costly to construct, so each language and style is built once. */
function dateFormat(language: Language, style: keyof typeof dateStyles) {
  const key = `${language}:${style}`;
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat(language === "zh" ? "zh-CN" : "en", {
      ...dateStyles[style],
      timeZone: "UTC",
    });
    dateFormats.set(key, format);
  }
  return format;
}
export function shortDay(date: string, language: Language): string {
  return dateFormat(language, "weekday").format(dayDate(date));
}
/** "Mon, Oct 12" or "10月12日周一"; ISO dates stay for storage keys. */
export function readableDate(date: string, language: Language): string {
  const style =
    Number(date.slice(0, 4)) === new Date().getFullYear() ? "day" : "dayYear";
  return dateFormat(language, style).format(dayDate(date));
}
/** "Oct 12" or "10月12日". */
export function monthDay(date: string, language: Language): string {
  const style =
    Number(date.slice(0, 4)) === new Date().getFullYear()
      ? "monthDay"
      : "monthDayYear";
  return dateFormat(language, style).format(dayDate(date));
}
/** "Week 42 · from Oct 11" or "第 42 周 · 10月11日起", with the stable Monday ID's ISO week number. */
export function weekLabel(weekStart: string, language: Language): string {
  const start = planningWeekStart(weekStart);
  const week = Number(isoWeek(addDays(start, 1)).split("-W")[1]);
  const from = monthDay(start, language);
  return language === "zh"
    ? `第 ${week} 周 · ${from}起`
    : `Week ${week} · from ${from}`;
}
/** A task's shown title, or that it is unavailable. */
export function taskTitle(
  title: string | undefined,
  language: Language,
): string {
  if (title !== undefined) return displayedTitle(title);
  return words(language).missingTask;
}
