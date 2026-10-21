import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  DragDropProvider,
  DragOverlay,
  useDragOperation,
} from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { SortableKeyboardPlugin } from "@dnd-kit/dom/sortable";
import { pointerIntersection } from "@dnd-kit/collision";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  GripVertical,
} from "lucide-react";
import {
  addDays,
  displayedTitle,
  effectiveArea,
  formattedMinutes,
  mondayOf,
  monthStart,
  taskIndex,
} from "./domain";
import { unplannedDue, unplannedText } from "./deadlines";
import {
  dragHandle,
  dragInstructions,
  spokenDrags,
  type SpokenName,
} from "./drag-announcements";
import { FocusBlock, focusTitle, type FocusBlockProps } from "./FocusBlock";
import type { RecordWrite } from "./FocusEntries";
import { FocusMonth } from "./FocusMonth";
import { FocusWeek } from "./FocusWeek";
import { areaColor, outcomeForTask } from "./planning-outcomes";
import { moved, pendingStep, predictMove, withRecord } from "./plan-updates";
import { planningSensors } from "./row-drag";
import { monthLabel, readableDate, weekLabel } from "./PlanningCalendar";
import { LoggedTime } from "./StatusMarks";
import { words } from "./i18n";
import type { IdlePause } from "./useIdlePause";
import type {
  Area,
  DayPlan,
  DeletedEntry,
  FocusRange,
  FocusState,
  Language,
  PlanState,
  PlanningTask,
  PlusActions,
  RunOperation,
  SavedEntry,
} from "./model";

/** Focus's three views: one day's steps, a week's time and a month's. */
export type FocusTab = "day" | "week" | "month";

/** The first and last day a view shows around `date`. */
export function focusRange(tab: FocusTab, date: string): [string, string] {
  if (tab === "day") return [date, date];
  if (tab === "week") {
    const monday = mondayOf(date);
    return [monday, addDays(monday, 6)];
  }
  const first = monthStart(date);
  return [first, addDays(monthStart(date, 1), -1)];
}

/** What a Focus drag says: the dragged step's title, and the place it is over. */
export function focusDragName(language: Language): SpokenName {
  return (data, as) => {
    if (as === "target" && typeof data?.position === "number")
      return language === "zh"
        ? `第 ${data.position + 1} 项`
        : `position ${data.position + 1}`;
    return typeof data?.title === "string" ? data.title : undefined;
  };
}

/** The page header's line: the day, week or month Focus shows. */
export function focusLabel(
  tab: FocusTab,
  date: string,
  language: Language,
): string {
  if (tab === "day") return readableDate(date, language);
  if (tab === "week") return weekLabel(mondayOf(date), language);
  return monthLabel(date, language);
}

interface Props {
  plan: PlanState;
  /** Tasks' today: its queue and records, and the timer. */
  focus: FocusState;
  /** The queues the quiet deadline line looks in: this week's, or only today's. */
  days?: readonly DayPlan[];
  /** Opens Plan › Review with Start now focused. */
  onShowStart?: () => void;
  /** The view shown, Day unless another is chosen. */
  tab?: FocusTab;
  /** The day the view is around; today unless another is chosen. */
  date?: string;
  /** Shows another view or date. */
  onNavigate?: (tab: FocusTab, date: string) => void;
  language: Language;
  busy: boolean;
  /** Day cards whose queue write is not yet confirmed. */
  pending?: ReadonlySet<string>;
  /** Completed task IDs that wait for the re-read showing the result. */
  completing?: ReadonlySet<string>;
  /** Record writes go through the App's queue; other days are read with `readFocus`. */
  actions: PlusActions;
  run: RunOperation;
  /** Confirmed writes so far: each one reads the days shown again. */
  written?: number;
  /** The header's Completed checkbox: the day's completed steps follow the open ones. */
  showCompleted?: boolean;
  /** Opens Tasks' own task dialog, where a completed step can be reopened. */
  onOpenTask: (id: string) => void;
  editTask: (task: PlanningTask) => void;
  complete: (task: PlanningTask) => void;
  onOpenPlan: () => void;
  /** A timer command; Start sends the chosen pomodoro length, none to count up, and the task's area. */
  onTimer: (
    action: "start" | "pause" | "resume" | "stop",
    taskId: string,
    targetSeconds?: number,
    area?: Area,
  ) => void;
  /** Pause when away's toggle, shown after the Timer select; absent without the API or a host setting. */
  idlePause?: IdlePause["toggle"];
}

/**
 * Focus: Day, Week and Month with their dates. Today's Day is the page's own data; any other range
 * is read from Tasks and kept while Focus is open, and what was shown stays, dimmed, until the next
 * range arrives.
 */
export function FocusView(props: Props) {
  const {
    focus,
    tab = "day",
    onNavigate = () => {},
    language,
    actions,
    run,
    written = 0,
  } = props;
  const text = words(language);
  const today = focus.date;
  const date = props.date ?? today;
  const [start, end] = focusRange(tab, date);
  const onToday = tab === "day" && date === today;
  const read = useFocusRange(actions, start, end, written, onToday);
  const current: FocusRange | undefined = onToday
    ? { days: [focus], tasks: focus.tasks, today }
    : read.range;
  // What each view showed last, kept on screen while its next range loads.
  const last = useRef<Partial<Record<FocusTab, FocusRange>>>({});
  useEffect(() => {
    if (current) last.current[tab] = current;
  });
  const shown = current ?? last.current[tab];
  const waiting = !current && Boolean(shown);
  // Confirm-first: a record shows its new value once Tasks saved it; until then its row waits.
  const writeRecord: RecordWrite = (key, write) =>
    run(
      async () => {
        const result = await write();
        read.merge(result);
        return result;
      },
      { pending: [key] },
    );
  const openDay = (day: string) => onNavigate("day", day);
  return (
    <>
      <FocusToolbar
        tab={tab}
        date={date}
        today={today}
        language={language}
        onNavigate={onNavigate}
      />
      {read.failed && (
        <div className="plus-error" role="alert">
          <span>{text.loadFailed}</span>
          <button onClick={read.retry}>{text.refresh}</button>
        </div>
      )}
      {shown ? (
        <div
          className={`plus-focus-range ${waiting ? "is-loading" : ""}`}
          aria-busy={(!onToday && read.loading) || undefined}
          inert={waiting || undefined}
        >
          {tab === "day" ? (
            <FocusDay
              {...props}
              day={shown.days[0]!}
              tasks={shown.tasks}
              writeRecord={writeRecord}
            />
          ) : tab === "week" ? (
            <FocusWeek
              range={shown}
              today={today}
              language={language}
              onOpenDay={openDay}
            />
          ) : (
            <FocusMonth
              range={shown}
              month={shown.days[0]!.date.slice(0, 7)}
              today={today}
              language={language}
              onOpenDay={openDay}
            />
          )}
        </div>
      ) : (
        !read.failed && (
          <p className="plus-muted" role="status">
            {text.loadingDays}
          </p>
        )
      )}
    </>
  );
}

/**
 * Focus days of a range from Tasks, kept per range while Focus is open. Each confirmed write reads
 * the shown range again, so a stopped session's record or a completion shows; a record write also
 * merges into every kept range at once.
 */
function useFocusRange(
  actions: PlusActions,
  start: string,
  end: string,
  written: number,
  skip: boolean,
) {
  const cache = useRef(
    new Map<string, { range: FocusRange; written: number }>(),
  );
  const [, setReads] = useState(0);
  const [failed, setFailed] = useState("");
  const [attempt, setAttempt] = useState(0);
  const key = `${start}/${end}`;
  const saved = skip ? undefined : cache.current.get(key);
  const fresh = saved?.written === written;
  useEffect(() => {
    if (skip || fresh) return;
    let current = true;
    actions.readFocus(start, end).then(
      (range) => {
        if (!current) return;
        cache.current.set(key, { range, written });
        setFailed("");
        setReads((count) => count + 1);
      },
      () => {
        if (current) setFailed(key);
      },
    );
    return () => {
      current = false;
    };
  }, [actions, start, end, key, written, skip, fresh, attempt]);
  return {
    range: saved?.range,
    loading: !skip && !fresh && failed !== key,
    failed: !skip && failed === key,
    retry() {
      setFailed("");
      setAttempt((count) => count + 1);
    },
    merge(result: SavedEntry | DeletedEntry) {
      const entry = "savedEntry" in result ? result.savedEntry : undefined;
      const removed =
        "deletedEntry" in result ? result.deletedEntry : undefined;
      for (const [range, value] of cache.current)
        cache.current.set(range, {
          ...value,
          range: {
            ...value.range,
            days: value.range.days.map((day) =>
              withRecord(day, entry, removed),
            ),
          },
        });
      setReads((count) => count + 1);
    },
  };
}

/** Day, Week and Month, then the previous and next day, week or month, and Today. */
function FocusToolbar({
  tab,
  date,
  today,
  language,
  onNavigate,
}: {
  tab: FocusTab;
  date: string;
  today: string;
  language: Language;
  onNavigate: (tab: FocusTab, date: string) => void;
}) {
  const text = words(language);
  const step = (direction: number) => {
    if (tab === "day") return addDays(date, direction);
    if (tab === "week") return addDays(date, 7 * direction);
    return monthStart(date, direction);
  };
  const [previous, next] = {
    day: [text.previousDay, text.nextDay],
    week: [text.previousWeek, text.nextWeek],
    month: [text.previousMonth, text.nextMonth],
  }[tab];
  const there =
    tab === "day"
      ? date === today
      : tab === "week"
        ? mondayOf(date) === mondayOf(today)
        : date.slice(0, 7) === today.slice(0, 7);
  return (
    <div className="plus-focus-toolbar">
      <div
        className="planning-view-tabs"
        role="tablist"
        aria-label={text.focusView}
      >
        {(["day", "week", "month"] as const).map((value) => (
          <button
            key={value}
            role="tab"
            aria-selected={tab === value}
            onClick={() => onNavigate(value, date)}
          >
            {text[value]}
          </button>
        ))}
      </div>
      <nav
        className="plus-focus-nav"
        aria-label={language === "zh" ? "选择日期" : "Choose dates"}
      >
        <button aria-label={previous} onClick={() => onNavigate(tab, step(-1))}>
          <ChevronLeft size={18} />
        </button>
        <button aria-label={next} onClick={() => onNavigate(tab, step(1))}>
          <ChevronRight size={18} />
        </button>
        <button
          className="plus-focus-today"
          disabled={there}
          onClick={() => onNavigate(tab, today)}
        >
          {text.today}
        </button>
      </nav>
    </div>
  );
}

/**
 * One day's steps. Today they run: Start, the timer and completion. Any other day is read-only,
 * though records of today and past days can still be changed.
 */
function FocusDay({
  plan,
  focus,
  day,
  tasks,
  days = [focus],
  onShowStart,
  language,
  busy,
  pending,
  completing,
  actions,
  run,
  writeRecord,
  showCompleted = false,
  onOpenTask,
  editTask,
  complete,
  onOpenPlan,
  onTimer,
  idlePause,
}: Props & {
  day: DayPlan;
  tasks: FocusRange["tasks"];
  writeRecord: RecordWrite;
}) {
  const text = words(language);
  const doneHeading = useId();
  const otherHeading = useId();
  // The drag instructions every grip names.
  const hintId = useId();
  const list = useRef<HTMLOListElement>(null);
  // A step reordered keeps keyboard focus on its grip, though React moves its node.
  const [focusMoved, setFocusMoved] = useState<string>();
  const plugins = useMemo(
    () => spokenDrags(language, focusDragName(language)),
    [language],
  );
  useEffect(() => {
    if (!focusMoved || !list.current) return;
    setFocusMoved(undefined);
    // Only where focus was lost or is still in the list; never pulled back from elsewhere.
    const active = (list.current.getRootNode() as Document | ShadowRoot)
      .activeElement;
    if (active && active !== document.body && !list.current.contains(active))
      return;
    [...list.current.querySelectorAll<HTMLElement>(".plus-focus-slot")]
      .find((slot) => slot.dataset.taskId === focusMoved)
      ?.querySelector<HTMLElement>(".plus-focus-grip")
      ?.focus();
  }, [focusMoved]);
  // Counting up is the default: Start, work, then complete the step, which saves its time.
  const [targetSeconds, setTargetSeconds] = useState(0);
  const isToday = day.date === focus.date;
  const future = day.date > focus.date;
  const byId = taskIndex(plan.tasks);
  const queue = day.taskIds.filter((id) => !day.completedTaskIds.includes(id));
  const minutesOf = (id: string) =>
    focus.estimates[id] ??
    byId.get(id)?.estimatedMinutes ??
    tasks[id]?.estimatedMinutes ??
    0;
  const totalMinutes = queue.reduce((sum, id) => sum + minutesOf(id), 0);
  // The day's records, and the session when it counts on this day.
  const logged = day.entries.reduce((sum, entry) => sum + entry.seconds, 0);
  // Steps with records here that left the day's queue (moved on, removed): their time still counts
  // and stays editable, so every record of the day has a card.
  const others = future
    ? []
    : [...new Set(day.entries.map((entry) => entry.taskId))].filter(
        (id) => !day.taskIds.includes(id) && !day.completedTaskIds.includes(id),
      );
  const session = focus.timer?.day === day.date ? focus : undefined;
  const unknown = queue.filter((id) => !minutesOf(id)).length;
  let stepLabel = language === "zh" ? "个步骤" : "steps";
  if (language === "en" && queue.length === 1) stepLabel = "step";
  // A hint only: something that should have started has nothing planned this week.
  const due = unplannedDue(plan.tasks, days, focus.date, plan.dependencies);
  const openPlan = (
    <button className="plus-button" onClick={onOpenPlan}>
      <ArrowLeft size={15} />
      {language === "zh" ? "调整计划" : "Adjust plan"}
    </button>
  );
  const block = (
    id: string,
    index: number,
    mode: "today" | "readonly" | "done",
  ): FocusBlockProps => ({
    mode,
    taskId: id,
    task: byId.get(id),
    known: tasks[id],
    plan,
    focus,
    date: day.date,
    // A future day has nothing to log yet.
    records: future
      ? undefined
      : day.entries.filter((entry) => entry.taskId === id),
    language,
    busy,
    pending,
    actions,
    writeRecord,
    settling:
      mode === "today" &&
      Boolean(completing?.has(id) || pending?.has(pendingStep(day.date, id))),
    onTimer: (action, taskId) => {
      const task = byId.get(taskId);
      if (action !== "start") onTimer(action, taskId);
      else if (task)
        onTimer(
          action,
          taskId,
          targetSeconds || undefined,
          effectiveArea(task, plan.tasks),
        );
    },
    editTask,
    complete,
    onOpenTask,
    index,
    minutes: minutesOf(id),
  });
  const steps = (
    <ol
      ref={list}
      className={`plus-focus-stack ${isToday ? "is-sortable" : ""}`}
      aria-label={
        isToday
          ? language === "zh"
            ? "今天的步骤"
            : "Today's steps"
          : `${language === "zh" ? "步骤" : "Steps"}: ${readableDate(day.date, language)}`
      }
    >
      {queue.map((id, index) =>
        isToday ? (
          <SortableFocusBlock
            key={id}
            {...block(id, index, "today")}
            hint={hintId}
          />
        ) : (
          <FocusBlock key={id} {...block(id, index, "readonly")} />
        ),
      )}
    </ol>
  );
  return (
    <>
      <div className="plus-focus-summary">
        <div className="plus-focus-totals">
          <strong>{formattedMinutes(totalMinutes)}</strong>
          <span>
            {queue.length} {stepLabel}
          </span>
          {unknown > 0 && (
            <span>
              {unknown} {text.unknown.toLowerCase()}
            </span>
          )}
          {(logged > 0 || session) && (
            <span>
              ·{" "}
              <LoggedTime
                seconds={logged}
                session={session}
                label={text.logged}
              />
            </span>
          )}
        </div>
        {queue.length > 0 && (
          <div className="plus-focus-controls">
            {isToday && (
              <label className="plus-focus-duration">
                {language === "zh" ? "计时" : "Timer"}
                <select
                  aria-label={language === "zh" ? "计时方式" : "Timer duration"}
                  value={targetSeconds}
                  disabled={busy || Boolean(focus.timer)}
                  onChange={(event) =>
                    setTargetSeconds(Number(event.target.value))
                  }
                >
                  <option value={0}>
                    {language === "zh" ? "正计时" : "Count up"}
                  </option>
                  <option value={25 * 60}>
                    {language === "zh" ? "25 分钟" : "25 min"}
                  </option>
                  <option value={50 * 60}>
                    {language === "zh" ? "50 分钟" : "50 min"}
                  </option>
                </select>
              </label>
            )}
            {isToday && idlePause && (
              <label
                className="plus-completed-toggle"
                title={text.pauseWhenAwayHint}
              >
                <input
                  type="checkbox"
                  checked={idlePause.checked}
                  onChange={(event) => idlePause.onChange(event.target.checked)}
                />
                {text.pauseWhenAway}
              </label>
            )}
            {isToday && idlePause?.refused && (
              <span className="plus-idle-refused">{text.awayRefused}</span>
            )}
            {openPlan}
          </div>
        )}
      </div>
      {isToday && focus.finishedPomodoro && (
        <p className="plus-muted" role="status">
          {formattedMinutes(focus.finishedPomodoro.targetSeconds / 60)}{" "}
          {language === "zh" ? "专注已完成" : "focus completed"}
        </p>
      )}
      {isToday && due.past + due.window > 0 && (
        <button
          className="planning-runway plus-focus-runway"
          title={text.showInPlan}
          onClick={onShowStart}
        >
          {unplannedText(due, language)}
        </button>
      )}
      {queue.length > 0 && !isToday && steps}
      {queue.length > 0 && isToday && (
        // Only today's open steps reorder: one MoveFocusStep within the day per drop.
        <DragDropProvider
          key={language}
          plugins={plugins}
          sensors={planningSensors}
          onDragEnd={({ canceled, operation }) => {
            if (canceled) return;
            const source = operation.source?.data as
              { taskId?: string; position?: number } | undefined;
            const target = operation.target?.data as
              { taskId?: string; position?: number } | undefined;
            if (
              !source?.taskId ||
              source.position === undefined ||
              target?.position === undefined ||
              source.taskId === target.taskId
            )
              return;
            const id = source.taskId;
            const next = moved(queue, source.position, target.position);
            const beforeId = next[next.indexOf(id) + 1];
            // The step shows in its new place at once and waits there until Tasks confirms.
            void run(() => actions.moveTaskToDay(id, day, day, beforeId), {
              pending: [pendingStep(day.date, id)],
              predict: predictMove(id, day.date, day.date, beforeId),
            });
            setFocusMoved(id);
          }}
        >
          {/* Hidden, like dnd-kit's own: read only as the grips' description. */}
          <span id={hintId} hidden>
            {dragInstructions(language)}
          </span>
          {steps}
          {/* Finish preview cleanup at once, keeping dnd-kit's keyboard focus restoration. */}
          <DragOverlay
            style={{ pointerEvents: "none" }}
            dropAnimation={() => undefined}
          >
            {(source) => {
              const id = String(source.data?.taskId ?? "");
              const task = byId.get(id);
              const outcome = task
                ? outcomeForTask(task, plan.tasks)
                : undefined;
              return (
                <div
                  className="planning-step-overlay plus-focus-overlay"
                  aria-hidden="true"
                  inert
                  style={
                    {
                      "--area-color": task
                        ? areaColor(task, plan.tasks)
                        : "var(--plus-area-none)",
                    } as CSSProperties
                  }
                >
                  <strong>{String(source.data?.title ?? "")}</strong>
                  {outcome && outcome.id !== id && (
                    <small>{displayedTitle(outcome.title)}</small>
                  )}
                </div>
              );
            }}
          </DragOverlay>
        </DragDropProvider>
      )}
      {queue.length === 0 && (
        <section className="plus-focus-empty">
          <p>
            {isToday
              ? language === "zh"
                ? "今天还没有安排步骤。"
                : "No steps planned for today."
              : text.noStepsDay}
          </p>
          {openPlan}
        </section>
      )}
      {showCompleted && day.completedTaskIds.length > 0 && (
        <section className="plus-focus-done" aria-labelledby={doneHeading}>
          <h2 id={doneHeading} className="plus-focus-divider">
            {text.completed}
          </h2>
          {/* Never inside the queue: completed steps are not reordered or started. */}
          <ul className="plus-focus-stack">
            {day.completedTaskIds.map((id, index) => (
              <FocusBlock key={id} {...block(id, index, "done")} />
            ))}
          </ul>
        </section>
      )}
      {others.length > 0 && (
        <section className="plus-focus-other" aria-labelledby={otherHeading}>
          <h2 id={otherHeading} className="plus-focus-divider">
            {text.otherTime}
          </h2>
          {/* Read-only: only their records change here. */}
          <ul className="plus-focus-stack">
            {others.map((id, index) => (
              <FocusBlock key={id} {...block(id, index, "readonly")} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

/**
 * One of today's open steps, which drags by its whole row to another step's place, or by its grip
 * with the keyboard. A step waiting for a write, or with a session, stays where it is.
 */
function SortableFocusBlock({
  hint,
  ...props
}: FocusBlockProps & {
  /** The ID of the drag instructions, which every grip names. */
  hint: string;
}) {
  const { taskId, index: position, language, busy, settling = false } = props;
  const title = focusTitle(props.task, props.known, language);
  const timed =
    props.focus.timer?.taskId === taskId &&
    props.focus.timer.day === props.date;
  const { ref, handleRef, isDragSource } = useSortable({
    id: `focus:${taskId}`,
    index: position,
    group: `focus:${props.date}`,
    type: "focus-step",
    accept: "focus-step",
    // As in Week: the arrows step between steps, and nothing moves the DOM while dragging.
    plugins: [SortableKeyboardPlugin],
    collisionDetector: pointerIntersection,
    disabled: busy || settling || timed,
    data: { taskId, title, position },
  });
  // A step dragged over this one draws the line where it will land: before it moving earlier,
  // after it moving later.
  const { source, target } = useDragOperation();
  const from = source?.data?.position as number | undefined;
  const insert =
    target?.id === `focus:${taskId}` &&
    source?.id !== target.id &&
    from !== undefined
      ? position < from
        ? "before"
        : "after"
      : undefined;
  return (
    <FocusBlock
      {...props}
      slotRef={ref}
      dragging={isDragSource}
      insert={insert}
      grip={
        <button
          ref={handleRef}
          type="button"
          className="plus-focus-grip"
          {...dragHandle(language, hint)}
          // A waiting grip stays focusable, so a keyboard drop keeps focus on the step.
          disabled={busy || timed}
          aria-disabled={settling || undefined}
          title={
            timed
              ? language === "zh"
                ? "先结束当前计时再移动"
                : "Stop the current session before moving this step"
              : undefined
          }
          aria-label={`${language === "zh" ? "移动步骤：" : "Move step: "}${title}${settling ? `, ${words(language).updating}` : ""}`}
        >
          <GripVertical size={14} />
        </button>
      }
    />
  );
}
