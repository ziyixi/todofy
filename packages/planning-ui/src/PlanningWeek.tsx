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
import { ChevronDown, ChevronRight, GripVertical } from "lucide-react";
import {
  displayedTitle,
  effectiveArea,
  formattedMinutes,
  taskIndex,
} from "./domain";
import { AddStep } from "./AddStep";
import {
  dragHandle,
  dragInstructions,
  spokenDrags,
  type SpokenName,
} from "./drag-announcements";
import {
  CompleteTaskButton,
  type CompletePlanningTask,
} from "./CompleteTaskButton";
import { OutcomeCard } from "./ReviewBoard";
import { PlanningCalendar, shortDay, taskTitle } from "./PlanningCalendar";
import {
  areaColor,
  committedOutcomes,
  isParked,
  MAX_LANE_TASKS,
  outcomeForTask,
  outcomeSteps,
  stepSiblings,
} from "./planning-outcomes";
import {
  moved,
  pendingStep,
  pendingTask,
  predictChildOrder,
  predictMove,
} from "./plan-updates";
import { PendingMark } from "./StatusMarks";
import { FullTitle, markCut } from "./FullTitle";
import { QuickTasks } from "./QuickTasks";
import { planningSensors } from "./row-drag";
import { useLaneReorder } from "./lane-reorder";
import { quickTray, unscheduledCommitments } from "./weekly-review";
import { words } from "./i18n";
import type {
  Area,
  DayPlan,
  FocusState,
  Language,
  PlanState,
  PlanningTask,
  PlusActions,
  RunOperation,
} from "./model";

interface Props {
  plan: PlanState;
  days: DayPlan[];
  /** Titles of queued tasks Plan's list leaves out. */
  focusTasks: FocusState["tasks"];
  timer?: FocusState["timer"];
  currentDate: string;
  language: Language;
  busy: boolean;
  pending?: ReadonlySet<string>;
  actions: PlusActions;
  run: RunOperation;
  editTask: (task: PlanningTask) => void;
  completeTask: CompletePlanningTask;
  onWeekChange: (week: string) => void;
  /** The selected commitment: absent for the first one, "" for none. PlanView keeps it. */
  selectedId?: string;
  onSelect: (id: string) => void;
  /** Week's own area filter, which the weekly review's "Plan steps" resets. */
  area: Area | "all";
  onArea: (area: Area | "all") => void;
  /** Committed folded to its heading line; Next steps stays. */
  folded: boolean;
  onFold: (folded: boolean) => void;
  /**
   * The commitment whose Add steps input is open, which the weekly review's Plan steps also opens;
   * any other selected commitment shows it closed.
   */
  addingStep?: string;
  onAddingStep: (id: string | undefined) => void;
}
/**
 * What a Week drag says: the dragged step's or commitment's title; over a day its short name, over
 * a commitment its place in Committed, over a sibling step its place among the steps.
 */
export function weekDragName(language: Language): SpokenName {
  return (data, as) => {
    if (as === "target" && typeof data?.date === "string")
      return shortDay(data.date, language);
    if (as === "target" && typeof data?.position === "number")
      return data.lane === "committed"
        ? language === "zh"
          ? `${words(language).committed}第 ${data.position + 1} 项`
          : `${words(language).committed}, position ${data.position + 1}`
        : language === "zh"
          ? `第 ${data.position + 1} 步`
          : `step ${data.position + 1}`;
    return typeof data?.title === "string" ? data.title : undefined;
  };
}

export function PlanningWeek(props: Props) {
  const {
    plan,
    days,
    focusTasks,
    timer,
    currentDate,
    language,
    busy,
    pending,
    actions,
    run,
    editTask,
    completeTask,
    onWeekChange,
    selectedId,
    onSelect,
    area,
    onArea,
    folded,
    onFold,
    addingStep,
    onAddingStep,
  } = props;
  const gridId = useId();
  // The drag instructions every handle names, in Week's own shadow root.
  const hintId = useId();
  const week = useRef<HTMLElement>(null);
  // A reorder's request ID, reused when the same reorder is tried again.
  const reorderRequests = useRef(new Map<string, string>());
  // Committed is Review's Committed lane: the same order, written the same way.
  const reorderLane = useLaneReorder(actions, run);
  // A commitment reordered keeps keyboard focus on its grip, though React moves its node.
  const [focusMoved, setFocusMoved] = useState<string>();
  // A drag speaks of titles, places and days.
  const plugins = useMemo(
    () => spokenDrags(language, weekDragName(language)),
    [language],
  );
  useEffect(() => {
    if (!focusMoved || !week.current) return;
    setFocusMoved(undefined);
    // Only where focus was lost or is still in Week; never pulled back from elsewhere.
    const active = (week.current.getRootNode() as Document | ShadowRoot)
      .activeElement;
    if (active && active !== document.body && !week.current.contains(active))
      return;
    [
      ...week.current.querySelectorAll<HTMLElement>(
        ".planning-commitment > .planning-outcome-card",
      ),
    ]
      .find((card) => card.dataset.outcomeId === focusMoved)
      ?.parentElement?.querySelector<HTMLElement>(".review-drag-handle")
      ?.focus();
  }, [focusMoved]);
  const committed = committedOutcomes(plan);
  // Each commitment's place in the whole lane, which a reorder writes; a filter shows fewer.
  const positions = new Map(committed.map((task, index) => [task.id, index]));
  // One quiet line, not a mark per card: commitments with nothing in these seven days.
  const unplanned = unscheduledCommitments(plan, days);
  // A remembered commitment that is no longer committed falls back to the first one.
  const selected =
    selectedId === ""
      ? undefined
      : (committed.find((task) => task.id === selectedId) ?? committed[0]);
  const shown = committed.filter(
    (task) => area === "all" || effectiveArea(task, plan.tasks) === area,
  );
  // A step set aside is in Review's Parked lane, not among the next steps.
  const steps = selected
    ? outcomeSteps(selected, plan.tasks, plan.managedLabels).filter(
        (task) => !isParked(task),
      )
    : [];
  const scheduledIds = new Set(
    days.flatMap((day) =>
      day.taskIds.filter((id) => !day.completedTaskIds.includes(id)),
    ),
  );
  function selectNextUnplanned() {
    const index = unplanned.findIndex((task) => task.id === selected?.id);
    const next = unplanned[(index + 1) % unplanned.length]!;
    if (area !== "all" && effectiveArea(next, plan.tasks) !== area)
      onArea("all");
    onSelect(next.id);
  }
  function selectArea(next: Area | "all") {
    onArea(next);
    if (
      next !== "all" &&
      selected &&
      effectiveArea(selected, plan.tasks) !== next
    )
      onSelect(
        committed.find((task) => effectiveArea(task, plan.tasks) === next)
          ?.id ?? "",
      );
  }
  /**
   * Moves a step from `from` to `to` among its siblings, in Todoist's order: one ReorderTasks
   * with the parent's children, which Todofy writes as their positions.
   */
  function reorderStep(id: string, from: number, to: number) {
    const task = taskIndex(plan.tasks).get(id);
    if (!task) return;
    const siblings = stepSiblings(task, plan.tasks);
    const ids = siblings.map((item) => item.id);
    const next = moved(ids, from, to);
    if (next.every((item, index) => item === ids[index])) return;
    // Without every position, or with more children than one request takes, Todoist keeps its
    // order, so nothing is written.
    const predict = predictChildOrder(plan.tasks, next);
    if (!predict || next.length > MAX_LANE_TASKS) return;
    const key = [
      id,
      next.join(","),
      siblings.map((item) => item.childOrder).join(","),
    ].join("|");
    const requestId = reorderRequests.current.get(key) ?? crypto.randomUUID();
    reorderRequests.current.set(key, requestId);
    void run(
      async () => {
        const result = await actions.reorderTasks(next, id, "", requestId);
        reorderRequests.current.delete(key);
        return result;
      },
      // A reorder changes the siblings' revisions too; their next writes need the returned etags.
      { pending: next.map(pendingTask), predict },
    );
  }
  return (
    <DragDropProvider
      key={language}
      plugins={plugins}
      sensors={planningSensors}
      onDragEnd={({ canceled, operation }) => {
        if (canceled) return;
        // A commitment dropped on another takes its place in Committed; nothing else takes one.
        const moving = operation.source?.data as
          { task?: PlanningTask; lane?: string; position?: number } | undefined;
        if (moving?.lane === "committed") {
          const over = operation.target?.data as
            { lane?: string; position?: number } | undefined;
          if (
            moving.task &&
            moving.position !== undefined &&
            over?.lane === "committed" &&
            over.position !== undefined &&
            reorderLane(
              moving.task,
              "committed",
              committed,
              moving.position,
              over.position,
            )
          )
            setFocusMoved(moving.task.id);
          return;
        }
        const source = operation.source?.data as
          | {
              taskId?: string;
              sourceDate?: string;
              siblings?: string;
              position?: number;
            }
          | undefined;
        const target = operation.target?.data as
          | {
              date?: string;
              beforeId?: string;
              taskId?: string;
              siblings?: string;
              position?: number;
            }
          | undefined;
        // A step dropped on a sibling takes its place; its sortable accepts no other step.
        if (target?.siblings) {
          if (
            source?.taskId &&
            source.position !== undefined &&
            target.position !== undefined &&
            source.taskId !== target.taskId &&
            source.siblings === target.siblings
          )
            reorderStep(source.taskId, source.position, target.position);
          return;
        }
        const day = days.find((day) => day.date === target?.date);
        if (!source?.taskId || !day || source.taskId === target?.beforeId)
          return;
        const id = source.taskId;
        const from = days.find((day) => day.date === source.sourceDate);
        // The card shows in its new place at once and waits there until Tasks confirms.
        void run(() => actions.moveTaskToDay(id, from, day, target?.beforeId), {
          pending: [pendingStep(day.date, id)],
          predict: predictMove(id, from?.date, day.date, target?.beforeId),
        });
      }}
    >
      <section
        ref={week}
        className="planning-week"
        aria-label={language === "zh" ? "一周安排" : "Weekly planning"}
      >
        {/* Hidden, like dnd-kit's own: read only as the handles' description. */}
        <span id={hintId} hidden>
          {dragInstructions(language)}
        </span>
        <header className="planning-commitment-heading">
          <div>
            <h2>
              <button
                className="planning-committed-toggle"
                aria-expanded={!folded}
                aria-controls={gridId}
                onClick={() => onFold(!folded)}
              >
                {folded ? (
                  <ChevronRight size={16} />
                ) : (
                  <ChevronDown size={16} />
                )}
                {words(language).committed}
              </button>
            </h2>
            <span>
              {committed.length}{" "}
              {language === "zh"
                ? "项"
                : committed.length === 1
                  ? "outcome"
                  : "outcomes"}
            </span>
            {unplanned.length > 0 && (
              <button
                className="planning-runway"
                title={language === "zh" ? "选中下一个" : "Select the next one"}
                onClick={selectNextUnplanned}
              >
                {language === "zh"
                  ? `${unplanned.length} 项承诺这 7 天还没有安排`
                  : `${unplanned.length} ${unplanned.length === 1 ? "commitment has" : "commitments have"} nothing planned in these 7 days`}
              </button>
            )}
          </div>
          {/* Folded, the filter and the grid stay mounted, so aria-controls always resolves. */}
          <div
            className="planning-area-filter"
            role="tablist"
            aria-label={language === "zh" ? "承诺范围" : "Commitment area"}
            hidden={folded}
          >
            {(
              [
                "all",
                "work",
                "personal",
                ...(committed.some(
                  (task) => effectiveArea(task, plan.tasks) === "unassigned",
                )
                  ? ["unassigned"]
                  : []),
              ] as (Area | "all")[]
            ).map((value) => (
              <button
                key={value}
                role="tab"
                aria-selected={area === value}
                // Work and Personal carry the cards' edge colour as a dot: the legend.
                data-area={
                  value === "work" || value === "personal" ? value : undefined
                }
                onClick={() => selectArea(value)}
              >
                {value === "all"
                  ? language === "zh"
                    ? "全部"
                    : "All"
                  : words(language)[value]}
              </button>
            ))}
          </div>
        </header>
        <div id={gridId} className="planning-commitment-grid" hidden={folded}>
          {shown.map((task, index) => (
            <Commitment
              key={task.id}
              task={task}
              index={index}
              position={positions.get(task.id)!}
              plan={plan}
              scheduledIds={scheduledIds}
              language={language}
              busy={busy}
              pending={pending?.has(pendingTask(task.id)) ?? false}
              selected={selected?.id === task.id}
              dragHint={hintId}
              // A click (or Enter) selects, and on the selected card changes nothing, its open
              // Add steps input included; a double-click opens it.
              onSelect={() => {
                if (selected?.id !== task.id) onSelect(task.id);
              }}
              editTask={editTask}
              completeTask={completeTask}
            />
          ))}
        </div>
        {selected ? (
          <section
            className="planning-step-tray"
            aria-label={`${words(language).steps}: ${displayedTitle(selected.title)}`}
            style={
              {
                "--area-color": areaColor(selected, plan.tasks),
              } as CSSProperties
            }
          >
            <header>
              <div>
                <span>{words(language).steps}</span>
                <strong>{displayedTitle(selected.title)}</strong>
              </div>
              <button
                aria-label={`${words(language).details}${language === "zh" ? "：" : ": "}${displayedTitle(selected.title)}`}
                onClick={() => editTask(selected)}
              >
                {words(language).details}
              </button>
            </header>
            {/* Every child has a stage of its own: none is a step here yet. */}
            {steps.length === 0 && (
              <p className="planning-step-tray-empty">
                {words(language).noChildren}
              </p>
            )}
            <div className="planning-tray-steps">
              {steps.map((task, index) => (
                <TrayStep
                  key={task.id}
                  task={task}
                  tasks={plan.tasks}
                  index={index}
                  position={stepSiblings(task, plan.tasks).indexOf(task)}
                  days={days}
                  timer={timer}
                  language={language}
                  busy={busy}
                  pending={pending?.has(pendingTask(task.id)) ?? false}
                  dragHint={hintId}
                  editTask={editTask}
                  completeTask={completeTask}
                />
              ))}
              {/* Keyed by the commitment: another one's selection closes it and drops the draft. */}
              <AddStep
                key={selected.id}
                outcome={selected}
                open={addingStep === selected.id}
                onOpenChange={(open) =>
                  onAddingStep(open ? selected.id : undefined)
                }
                busy={busy}
                run={run}
                actions={actions}
                tasks={plan.tasks}
                language={language}
              />
            </div>
          </section>
        ) : (
          <p className="planning-step-tray-empty">
            {folded
              ? words(language).expandToChoose
              : language === "zh"
                ? "选择上面的事项，安排它的小步骤。"
                : "Choose an outcome above to arrange its next steps."}
          </p>
        )}
        <QuickTasks
          tasks={quickTray(plan, currentDate, days, steps)}
          planTasks={plan.tasks}
          timer={timer}
          language={language}
          busy={busy}
          dragHint={hintId}
          editTask={editTask}
          completeTask={completeTask}
        />
        <PlanningCalendar
          plan={plan}
          days={days}
          focusTasks={focusTasks}
          timer={timer}
          currentDate={currentDate}
          language={language}
          busy={busy}
          pending={pending}
          dragHint={hintId}
          editTask={editTask}
          completeTask={completeTask}
          onWeekChange={onWeekChange}
          onRemove={(day, id) =>
            // The card stays, marked pending, until Tasks confirms the removal.
            void run(() => actions.removeFromDay(id, day.date), {
              pending: [pendingStep(day.date, id)],
            })
          }
        />
      </section>
      {/* Finish preview cleanup immediately, retaining dnd-kit's keyboard focus restoration. */}
      <DragOverlay
        style={{ pointerEvents: "none" }}
        dropAnimation={() => undefined}
      >
        {(source) => {
          const commitment = source.data?.task as PlanningTask | undefined;
          if (source.data?.lane === "committed" && commitment)
            // The commitment as it is in the grid, with its grip: dnd-kit sizes the overlay to it.
            return (
              <div className="review-drag-preview" aria-hidden="true" inert>
                <span className="review-drag-handle">
                  <GripVertical size={14} />
                </span>
                <OutcomeCard
                  task={commitment}
                  tasks={plan.tasks}
                  managedLabels={plan.managedLabels}
                  scheduledIds={scheduledIds}
                  language={language}
                  selected={selected?.id === commitment.id}
                  onClick={() => {}}
                />
              </div>
            );
          const id = String(source.data?.taskId ?? "");
          const task = taskIndex(plan.tasks).get(id);
          const outcome = task
            ? outcomeForTask(task, plan.tasks, plan.managedLabels)
            : undefined;
          return (
            <div
              className="planning-step-overlay"
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
              <strong>
                {taskTitle(task?.title ?? focusTasks[id]?.title, language)}
              </strong>
              {/* A quick task or a lone commitment is its own outcome: no second line. */}
              {outcome && outcome.id !== id && (
                <small>{displayedTitle(outcome.title)}</small>
              )}
            </div>
          );
        }}
      </DragOverlay>
    </DragDropProvider>
  );
}

/**
 * One commitment, which drags by its whole row to another commitment's place in Committed, or by
 * its grip with the keyboard: Review's Committed lane, the same order and the same write.
 */
function Commitment({
  task,
  index,
  position,
  plan,
  scheduledIds,
  language,
  busy,
  pending,
  selected,
  dragHint,
  onSelect,
  editTask,
  completeTask,
}: {
  task: PlanningTask;
  /** Its place among the commitments shown. */
  index: number;
  /** Its place in the whole lane. */
  position: number;
  plan: PlanState;
  scheduledIds: Set<string>;
  language: Language;
  busy: boolean;
  /** Its reorder is shown but not yet confirmed. */
  pending: boolean;
  selected: boolean;
  /** The ID of the drag instructions, which every handle names. */
  dragHint: string;
  onSelect: () => void;
  editTask: Props["editTask"];
  completeTask: CompletePlanningTask;
}) {
  const title = displayedTitle(task.title);
  const { ref, handleRef, isDragSource } = useSortable({
    id: `week-outcome:${task.id}`,
    index,
    group: "committed",
    type: "week-outcome",
    // Only another commitment: a dragged step never lands here.
    accept: "week-outcome",
    // As in Review: the arrows step between cards, and nothing moves the DOM while dragging.
    plugins: [SortableKeyboardPlugin],
    collisionDetector: pointerIntersection,
    collisionPriority: 2,
    disabled: busy || pending,
    data: { task, title, lane: "committed", position },
  });
  // A commitment dragged over this one draws the line where it will land: before it moving
  // earlier, after it moving later.
  const { source, target } = useDragOperation();
  const from = source?.data?.position as number | undefined;
  const insert =
    target?.id === `week-outcome:${task.id}` &&
    source?.id !== target.id &&
    source?.data?.lane === "committed" &&
    from !== undefined
      ? position < from
        ? "before"
        : "after"
      : undefined;
  return (
    <div
      ref={ref}
      className={`planning-commitment ${isDragSource ? "is-dragging" : ""} ${pending ? "is-pending" : ""} ${insert ? `is-insert-${insert}` : ""}`}
      aria-busy={pending || undefined}
    >
      <button
        ref={handleRef}
        type="button"
        className="review-drag-handle"
        {...dragHandle(language, dragHint)}
        // A waiting handle stays focusable, so a keyboard drop keeps focus on the moved card.
        disabled={busy}
        aria-disabled={pending || undefined}
        aria-label={`${language === "zh" ? "移动承诺：" : "Move commitment: "}${title}${pending ? `, ${words(language).updating}` : ""}`}
      >
        <GripVertical size={14} />
      </button>
      <OutcomeCard
        task={task}
        tasks={plan.tasks}
        managedLabels={plan.managedLabels}
        scheduledIds={scheduledIds}
        language={language}
        selected={selected}
        pending={pending}
        onClick={onSelect}
        onOpen={() => editTask(task)}
      />
      <CompleteTaskButton
        task={task}
        language={language}
        disabled={busy || pending}
        onComplete={() => completeTask(task)}
      />
    </div>
  );
}

/**
 * One next step: a drag into a day plans it there, and one onto a sibling (the same parent and
 * project) puts it in that place in Todoist's order. A fixed 60px card: one line of title, whose
 * full text floats on hover or focus, and one of estimate and days. An estimate of two hours or
 * more is drawn in the warning colour, which is the whole cue.
 */
function TrayStep({
  task,
  tasks,
  index,
  position,
  days,
  timer,
  language,
  busy,
  pending,
  dragHint,
  editTask,
  completeTask,
}: {
  task: PlanningTask;
  /** The plan's tasks, which give the step its area. */
  tasks: PlanningTask[];
  /** Its place among the steps shown. */
  index: number;
  /** Its place among its parent's children, which a reorder writes. */
  position: number;
  days: DayPlan[];
  timer?: FocusState["timer"];
  language: Language;
  busy: boolean;
  /** Its reorder is shown but not yet confirmed. */
  pending: boolean;
  /** The ID of the drag instructions, which every handle names. */
  dragHint: string;
  editTask: Props["editTask"];
  completeTask: CompletePlanningTask;
}) {
  const timing = timer?.taskId === task.id;
  const title = displayedTitle(task.title);
  // A commitment that is its own one step has no sibling to trade places with.
  const siblings = task.parentId
    ? `${task.parentId}|${task.projectId}`
    : undefined;
  const { ref, handleRef, isDragSource } = useSortable({
    id: `tray:${task.id}`,
    index,
    group: `steps:${task.parentId}`,
    type: "planning-step",
    accept: (source) => Boolean(siblings) && source.data?.siblings === siblings,
    // As in Review: the arrows step between targets, and nothing moves the DOM while dragging.
    plugins: [SortableKeyboardPlugin],
    collisionDetector: pointerIntersection,
    collisionPriority: 2,
    disabled: busy || timing || pending,
    data: { taskId: task.id, title, siblings, position },
  });
  // A sibling dragged over this step draws the line where it will land: before it moving
  // earlier, after it moving later.
  const { source, target } = useDragOperation();
  const from = source?.data?.position as number | undefined;
  const insert =
    target?.id === `tray:${task.id}` &&
    source?.id !== target.id &&
    source?.data?.siblings === siblings &&
    from !== undefined
      ? position < from
        ? "before"
        : "after"
      : undefined;
  const scheduled = days.filter(
    (day) =>
      day.taskIds.includes(task.id) && !day.completedTaskIds.includes(task.id),
  );
  const text = words(language);
  return (
    <article
      ref={ref}
      className={`planning-tray-step ${isDragSource ? "is-dragging" : ""} ${pending ? "is-pending" : ""} ${insert ? `is-insert-${insert}` : ""}`}
      data-task-id={task.id}
      aria-busy={pending || undefined}
      style={{ "--area-color": areaColor(task, tasks) } as CSSProperties}
    >
      <button
        ref={handleRef}
        className="planning-drag-handle"
        {...dragHandle(language, dragHint)}
        // A waiting handle stays focusable, so a keyboard reorder keeps focus on the step.
        disabled={busy || timing}
        aria-disabled={pending || undefined}
        title={
          timing
            ? language === "zh"
              ? "先结束当前计时再移动"
              : "Stop the current session before moving this step"
            : undefined
        }
        aria-label={`${language === "zh" ? "拖动步骤" : "Drag step"}: ${title}${pending ? `, ${text.updating}` : ""}`}
      >
        <GripVertical size={14} />
      </button>
      <button
        className="planning-step-title"
        onClick={() => editTask(task)}
        onPointerEnter={markCut}
        onFocus={markCut}
      >
        <FullTitle text={title} />
        <small>
          {task.estimatedMinutes === undefined ? (
            text.unknown
          ) : (
            <span
              className={
                task.estimatedMinutes >= 120 ? "planning-step-long" : undefined
              }
            >
              {formattedMinutes(task.estimatedMinutes)}
            </span>
          )}
          {scheduled.length > 0 &&
            ` · ${scheduled.map((day) => shortDay(day.date, language)).join(", ")}`}
        </small>
      </button>
      {pending && <PendingMark language={language} />}
      <CompleteTaskButton
        task={task}
        language={language}
        disabled={busy || pending}
        onComplete={() => completeTask(task)}
      />
    </article>
  );
}
