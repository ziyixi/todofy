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
  useDroppable,
} from "@dnd-kit/react";
import { useSortable } from "@dnd-kit/react/sortable";
import { SortableKeyboardPlugin } from "@dnd-kit/dom/sortable";
import { pointerIntersection } from "@dnd-kit/collision";
import { Flag, GripVertical } from "lucide-react";
import { displayedTitle, effectiveArea } from "./domain";
import { deadlineTitle, spokenDeadline } from "./deadlines";
import { dependencyIndex } from "./dependencies";
import {
  dragHandle,
  dragInstructions,
  spokenDrags,
} from "./drag-announcements";
import {
  areaColor,
  isParked,
  outcomeArea,
  outcomeSteps,
  PARKED_LABEL,
  reviewLanes,
} from "./planning-outcomes";
import { pendingTask, predictStage, withStage } from "./plan-updates";
import { useLaneReorder } from "./lane-reorder";
import { planningSensors } from "./row-drag";
import {
  boardLanes,
  cardState,
  cardStatus,
  statusLine,
  type BoardLanes,
} from "./review-lanes";
import {
  CompleteTaskButton,
  type CompletePlanningTask,
} from "./CompleteTaskButton";
import { PendingMark } from "./StatusMarks";
import { FullTitle, markCut } from "./FullTitle";
import { untouchedText } from "./weekly-review";
import { words } from "./i18n";
import type {
  Area,
  DayPlan,
  LaneId,
  Language,
  PlanState,
  PlanningTask,
  PlusActions,
  RunOperation,
  Stage,
} from "./model";

export interface OutcomeCardProps {
  task: PlanningTask;
  tasks: PlanningTask[];
  scheduledIds: Set<string>;
  /**
   * The account's today, on the Review board: there a card says that it waits or should start.
   * Week's commitment overview leaves it out and always shows the step counts.
   */
  today?: string;
  language: Language;
  selected?: boolean;
  /** Its stage change is shown but not yet confirmed. */
  pending?: boolean;
  /** On the Review board: the tasks it waits for that are not done (dependencies.ts). */
  waitsFor?: readonly PlanningTask[];
  /** At least one prerequisite, with all of them complete. */
  dependenciesDone?: boolean;
  /** In Parked: how long Todoist has not changed it, in place of the step counts. */
  untouched?: boolean;
  onClick: () => void;
  /** A double-click: Week's commitments select on a click and open their panel here. */
  onOpen?: () => void;
}
/**
 * A fixed-height card: a title of at most two lines, then one left-aligned line pinned to the
 * bottom with the step counts or, when the task waits or should start, one muted status in their
 * place. A two-part status puts its deadline part first, so that "N days late" is never cut. A
 * parked card says how long it has been untouched instead of its counts. The left edge says the
 * area, and so does the name. Only days past a deadline are drawn in --plus-danger.
 */
export function OutcomeCard({
  task,
  tasks,
  scheduledIds,
  today,
  language,
  selected = false,
  pending = false,
  waitsFor,
  dependenciesDone = false,
  untouched = false,
  onClick,
  onOpen,
}: OutcomeCardProps) {
  const steps = outcomeSteps(task, tasks);
  const planned = steps.filter((step) => scheduledIds.has(step.id)).length;
  const priority =
    task.priority > 1
      ? `P${5 - task.priority}`
      : language === "zh"
        ? "未设优先级"
        : "No priority";
  const title = displayedTitle(task.title);
  const state = today
    ? cardState(task, today, waitsFor, dependenciesDone)
    : undefined;
  // A parked card that waits still says so; otherwise its untouched days, when Todoist says.
  const untouchedLine =
    untouched && !state ? untouchedText(task, language) : "";
  const status =
    today && state
      ? cardStatus(task, state, today, language, waitsFor)
      : untouchedLine
        ? [{ text: untouchedLine }]
        : [];
  const hasStatus = Boolean(state || untouchedLine);
  const dated = Boolean(task.deadline && state);
  const line = statusLine(status);
  // Screen readers hear the status with the part of the deadline it does not already say.
  const spoken = line
    ? `, ${line}${dated ? spokenDeadline({ text: line }, task.deadline, language) : ""}`
    : "";
  // The deadline part first: the line ends in an ellipsis where the card is narrow.
  const shownStatus = status.length > 1 ? [status[1]!, status[0]!] : status;
  const area = outcomeArea(task, tasks, language);
  return (
    <button
      type="button"
      className={`planning-outcome-card ${selected ? "is-selected" : ""}`}
      style={{ "--area-color": areaColor(task, tasks) } as CSSProperties}
      data-outcome-id={task.id}
      onClick={onClick}
      onDoubleClick={onOpen}
      onPointerEnter={markCut}
      onFocus={markCut}
      // The name replaces the content, so it carries the area, status and pending state too.
      aria-label={`${title}, ${area}, ${priority}${spoken}${pending ? `, ${words(language).updating}` : ""}`}
    >
      <Flag
        size={14}
        className="planning-priority-mark"
        data-priority={task.priority}
        aria-hidden="true"
      >
        <title>{priority}</title>
      </Flag>
      <span className="planning-outcome-content">
        <span className="planning-outcome-title-row">
          <strong className="planning-outcome-title">
            <FullTitle text={title} />
          </strong>
          {pending && <PendingMark language={language} />}
        </span>
        <span className="planning-outcome-meta">
          {!hasStatus ? (
            <span className="planning-outcome-counts">
              {language === "zh"
                ? `${steps.length} 个步骤 · 已安排 ${planned}`
                : `${steps.length} ${steps.length === 1 ? "step" : "steps"} · ${planned} planned`}
            </span>
          ) : (
            <span
              className="planning-outcome-status"
              title={dated ? deadlineTitle(task.deadline, language) : undefined}
            >
              {shownStatus.map((part, index) => (
                <span
                  key={index}
                  className={part.quoted ? "has-quoted" : undefined}
                >
                  {index > 0 && (
                    <span className="planning-outcome-separator"> · </span>
                  )}
                  {part.text}
                  {part.quoted && (
                    <>
                      <span
                        className="planning-outcome-quoted"
                        title={part.quoted.title}
                      >
                        {part.quoted.title}
                      </span>
                      {part.quoted.close}
                    </>
                  )}
                  {part.danger && (
                    <span className="planning-danger-text">{part.danger}</span>
                  )}
                </span>
              ))}
            </span>
          )}
        </span>
      </span>
    </button>
  );
}

interface Props {
  plan: PlanState;
  /** Each task's one lane, from boardLanes. */
  lanes: BoardLanes;
  days: DayPlan[];
  area: Area | "all";
  currentDate: string;
  language: Language;
  busy: boolean;
  pending?: ReadonlySet<string>;
  actions: PlusActions;
  run: RunOperation;
  editTask: (task: PlanningTask) => void;
  completeTask: CompletePlanningTask;
}
/**
 * As many cards as Parked shows before "more", the most untouched: few, so that where the side
 * lanes sit above the stages a someday pile never pushes the stages out of view.
 */
const PARKED_SHOWN = 3;

/**
 * Parked and the four stage lanes. Ready tasks surface in Parked: a drag into a stage
 * also marks them in progress, as Start does. A manually parked task leaves its parked flag behind
 * when moved to a stage; a drop into Parked still sets it aside. Inside every lane a card
 * dropped on another card takes its place: Tasks keeps the lane's order, and the order of
 * the moved card's siblings follows (not for Parked).
 */
export function ReviewBoard({
  plan,
  lanes,
  days,
  area,
  currentDate,
  language,
  busy,
  pending,
  actions,
  run,
  editTask,
  completeTask,
}: Props) {
  const text = words(language);
  const board = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState("");
  // After a confirmed Start, focus moves on to the next card that can start, or to the board.
  const [focusAfter, setFocusAfter] = useState<{ id: string; next: string }>();
  // A card reordered in its lane keeps keyboard focus on its handle, though React moves its node.
  const [focusMoved, setFocusMoved] = useState<string>();
  const reorderLane = useLaneReorder(actions, run);
  // The drag instructions every handle names, in the board's own shadow root.
  const hintId = useId();
  // A drag speaks of card titles, lane names and positions.
  const plugins = useMemo(() => {
    const laneTitles: Record<string, string> = {
      parked: words(language).parked,
      ...Object.fromEntries(
        reviewLanes(language).map((lane) => [lane.stage, lane.title]),
      ),
    };
    return spokenDrags(language, (data, as) => {
      const lane = laneTitles[String(data?.lane)];
      const task = data?.task as PlanningTask | undefined;
      if (task && as === "source") return displayedTitle(task.title);
      if (typeof data?.position !== "number") return lane;
      return language === "zh"
        ? `${lane}第 ${data.position + 1} 项`
        : `${lane}, position ${data.position + 1}`;
    });
  }, [language]);
  const scheduledIds = new Set(
    days.flatMap((day) =>
      day.taskIds.filter((id) => !day.completedTaskIds.includes(id)),
    ),
  );
  const shown = (id: LaneId) =>
    lanes[id].filter(
      (task) => area === "all" || effectiveArea(task, plan.tasks) === area,
    );
  // Stage and Parked lanes accept a planning change.
  const columns: {
    id: LaneId;
    title: string;
    stage?: Exclude<Stage, "none">;
    label?: string;
  }[] = [
    { id: "parked" as const, title: text.parked, label: PARKED_LABEL },
    ...reviewLanes(language).map((lane) => ({
      id: lane.stage,
      title: lane.title,
      stage: lane.stage,
    })),
  ];
  // Once write controls are enabled again: the next card's Start, any Start, the started card
  // where it stays (in its stage lane) or the first card.
  useEffect(() => {
    if (!focusAfter || busy || !board.current) return;
    const starts = [
      ...board.current.querySelectorAll<HTMLElement>(".review-card-action"),
    ];
    const cards = [
      ...board.current.querySelectorAll<HTMLElement>(".planning-outcome-card"),
    ];
    (
      starts.find((start) => start.dataset.startId === focusAfter.next) ??
      starts[0] ??
      cards.find((card) => card.dataset.outcomeId === focusAfter.id) ??
      cards[0]
    )?.focus();
    setFocusAfter(undefined);
  }, [focusAfter, busy]);
  useEffect(() => {
    if (!focusMoved || !board.current) return;
    setFocusMoved(undefined);
    // Only where focus was lost or is still on the board; never pulled back from elsewhere.
    const active = (board.current.getRootNode() as Document | ShadowRoot)
      .activeElement;
    if (active && active !== document.body && !board.current.contains(active))
      return;
    [...board.current.querySelectorAll<HTMLElement>(".planning-outcome-card")]
      .find((card) => card.dataset.outcomeId === focusMoved)
      ?.parentElement?.querySelector<HTMLElement>(".review-drag-handle")
      ?.focus();
  }, [focusMoved]);

  async function start(task: PlanningTask) {
    // The next card that can start, in the board's order now.
    const ids = [
      ...(board.current?.querySelectorAll<HTMLElement>(".review-card-action") ??
        []),
    ].map((element) => element.dataset.startId);
    const next = ids[ids.indexOf(task.id) + 1] ?? "";
    if (await run(() => actions.updateTask(task, { active: true }))) {
      setAnnouncement(`${text.markedActive}: ${displayedTitle(task.title)}`);
      setFocusAfter({ id: task.id, next });
    }
  }
  return (
    <DragDropProvider
      key={language}
      plugins={plugins}
      sensors={planningSensors}
      onDragEnd={({ canceled, operation }) => {
        if (canceled) return;
        const task = operation.source?.data?.task as PlanningTask | undefined;
        const from = operation.source?.data?.lane as LaneId | undefined;
        const to = operation.target?.data?.lane as LaneId | undefined;
        if (!task || !from || !to) return;
        // In its own lane a card moves only when dropped on another card, not on the lane.
        if (from === to) {
          const start = operation.source?.data?.position as number | undefined;
          const end = operation.target?.data?.position as number | undefined;
          if (
            start !== undefined &&
            end !== undefined &&
            reorderLane(task, from, lanes[from], start, end)
          )
            setFocusMoved(task.id);
          return;
        }
        const column = columns.find((item) => item.id === to);
        if (!column || (!column.stage && to !== "parked")) return;
        const parking = to === "parked";
        const stage: Stage = column.stage ?? "none";
        // Picking up an automatically surfaced card acknowledges it in the existing stage write.
        const active = from === "parked" && !isParked(task) && !parking;
        // Only manual parking owns a parked flag; automatic readiness is read-derived.
        const parked = parking
          ? true
          : from === "parked" && isParked(task)
            ? false
            : undefined;
        const update = parking
          ? { parked: true }
          : {
              stage,
              ...(active ? { active } : {}),
              ...(parked === false ? { parked } : {}),
            };
        const after = boardLanes(
          withStage(plan, task.id, stage, active, parked),
          currentDate,
        );
        const onBoard = (lane: LaneId) =>
          after[lane].some((item) => item.id === task.id);
        // Acknowledged, a ready card may leave the board, but not come straight back to Parked. Any
        // other card must land in the lane it was dropped on: one that would come straight back, or
        // be only a step of its outcome's card again, writes nothing.
        if (active ? onBoard(from) : !onBoard(to)) return;
        // The card moves at once and waits in its new lane until Todoist confirms.
        void run(() => actions.updateTask(task, update), {
          pending: [pendingTask(task.id)],
          predict: predictStage(task.id, stage, active, parked),
        });
      }}
    >
      <div className="review-board" ref={board}>
        {/* Hidden, like dnd-kit's own: read only as the handles' description. */}
        <span id={hintId} hidden>
          {dragInstructions(language)}
        </span>
        <div className="review-lanes" data-lanes={columns.length}>
          {columns.map((column) => (
            <ReviewLane
              key={column.id}
              lane={column.id}
              stage={column.stage}
              title={column.title}
              label={column.label}
              tasks={shown(column.id)}
              positions={
                new Map(lanes[column.id].map((task, index) => [task.id, index]))
              }
              plan={plan}
              scheduledIds={scheduledIds}
              today={currentDate}
              language={language}
              busy={busy}
              pending={pending}
              dragHint={hintId}
              editTask={editTask}
              completeTask={completeTask}
              onStart={(task) => void start(task)}
            />
          ))}
        </div>
        <p className="plus-sr-only" role="status">
          {announcement}
        </p>
      </div>
      {/* Finish preview cleanup immediately, retaining dnd-kit's keyboard focus restoration. */}
      <DragOverlay
        style={{ pointerEvents: "none" }}
        dropAnimation={() => undefined}
      >
        {(source) => {
          const task = source.data?.task as PlanningTask | undefined;
          return task ? (
            // The card as it is in its lane, with its handle: dnd-kit sizes the overlay to it.
            <div className="review-drag-preview" aria-hidden="true" inert>
              <span className="review-drag-handle">
                <GripVertical size={14} />
              </span>
              <OutcomeCard
                task={task}
                tasks={plan.tasks}
                scheduledIds={scheduledIds}
                today={currentDate}
                language={language}
                waitsFor={dependencyIndex(plan).waitingFor.get(task.id)}
                dependenciesDone={dependencyIndex(plan).done.has(task.id)}
                onClick={() => {}}
              />
            </div>
          ) : null;
        }}
      </DragOverlay>
    </DragDropProvider>
  );
}

function ReviewLane({
  lane,
  stage,
  title,
  label,
  tasks,
  positions,
  plan,
  scheduledIds,
  today,
  language,
  busy,
  pending,
  dragHint,
  editTask,
  completeTask,
  onStart,
}: {
  lane: LaneId;
  /** A stage lane's stage. */
  stage?: Exclude<Stage, "none">;
  title: string;
  /** The label a drop writes. */
  label?: string;
  /** The cards shown, which an area filter may leave out. */
  tasks: PlanningTask[];
  /** Each card's position in the whole lane, which a reorder writes. */
  positions: ReadonlyMap<string, number>;
  plan: PlanState;
  scheduledIds: Set<string>;
  today: string;
  language: Language;
  busy: boolean;
  pending?: ReadonlySet<string>;
  /** The ID of the drag instructions, which every handle names. */
  dragHint: string;
  editTask: Props["editTask"];
  completeTask: CompletePlanningTask;
  onStart?: (task: PlanningTask) => void;
}) {
  const { ref } = useDroppable({
    id: `review-lane:${lane}`,
    accept: "review-outcome",
    disabled: busy,
    // Below its cards, which are the targets wherever the pointer is on one.
    collisionPriority: 1,
    data: { stage, lane },
  });
  // A card of another lane over this one lights it, if it takes drops; one of this lane over
  // another of its cards draws the line where it will land: before it moving up, after it down.
  const { source, target } = useDragOperation();
  const over = target?.data?.lane === lane;
  const ownCard = source?.data?.lane === lane;
  const lit = over && !ownCard && Boolean(stage || lane === "parked");
  const from = source?.data?.position as number | undefined;
  const to = target?.data?.position as number | undefined;
  const insert = (task: PlanningTask) =>
    over && ownCard && from !== undefined && to !== from
      ? positions.get(task.id) !== to
        ? undefined
        : to! < from
          ? "before"
          : "after"
      : undefined;
  const text = words(language);
  // Every ready card is visible; only the manual backlog folds after its first three.
  const [expanded, setExpanded] = useState(false);
  const visible =
    lane === "parked"
      ? tasks.filter((task) => !isParked(task)).length + PARKED_SHOWN
      : tasks.length;
  const cards = !expanded ? tasks.slice(0, visible) : tasks;
  const hidden = tasks.length - visible;
  return (
    <section
      ref={ref}
      className={`review-lane ${lit ? "is-over" : ""}`}
      aria-label={title}
      data-lane={lane}
      // A jump from Focus or the weekly review focuses the lane.
      tabIndex={-1}
    >
      <header className="review-lane-header">
        <h2>{title}</h2>
        <span>{tasks.length}</span>
      </header>
      <div className="review-lane-cards">
        {cards.map((task, index) => (
          <DraggableOutcome
            key={task.id}
            task={task}
            lane={lane}
            index={index}
            position={positions.get(task.id)!}
            insert={insert(task)}
            plan={plan}
            scheduledIds={scheduledIds}
            today={today}
            language={language}
            busy={busy}
            pending={pending?.has(pendingTask(task.id)) ?? false}
            dragHint={dragHint}
            editTask={editTask}
            completeTask={completeTask}
            onStart={onStart}
          />
        ))}
        {!tasks.length && label && (
          <p className="review-lane-empty">
            {lane === "parked"
              ? text.dropToPark
              : language === "zh"
                ? "拖入事项"
                : "Drop an outcome here"}
          </p>
        )}
        {lane === "parked" && hidden > 0 && (
          <button
            type="button"
            className="review-lane-more"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? text.showFewer : text.moreItems(hidden)}
          </button>
        )}
      </div>
    </section>
  );
}

function DraggableOutcome({
  task,
  lane,
  index,
  position,
  insert,
  plan,
  scheduledIds,
  today,
  language,
  busy,
  pending,
  dragHint,
  editTask,
  completeTask,
  onStart,
}: {
  task: PlanningTask;
  lane: LaneId;
  /** Its place among the cards shown. */
  index: number;
  /** Its place in the whole lane. */
  position: number;
  /** Where a card of this lane dragged over it would land. */
  insert?: "before" | "after";
  plan: PlanState;
  scheduledIds: Set<string>;
  today: string;
  language: Language;
  busy: boolean;
  pending: boolean;
  dragHint: string;
  editTask: Props["editTask"];
  completeTask: CompletePlanningTask;
  onStart?: (task: PlanningTask) => void;
}) {
  const { ref, handleRef, isDragSource } = useSortable({
    id: `review-outcome:${task.id}`,
    index,
    group: lane,
    type: "review-outcome",
    accept: "review-outcome",
    // The arrow keys step from card to card. Without dnd-kit's optimistic sorting nothing moves
    // the DOM during a drag: the order on screen is the data's, so a drop that writes nothing
    // leaves it as it was.
    plugins: [SortableKeyboardPlugin],
    // A card is the target only under the pointer: a drop in a gap moves nothing.
    collisionDetector: pointerIntersection,
    collisionPriority: 2,
    disabled: busy || pending,
    data: { task, lane, position },
  });
  const text = words(language);
  const title = displayedTitle(task.title);
  const waitsFor = dependencyIndex(plan).waitingFor.get(task.id);
  const dependenciesDone = dependencyIndex(plan).done.has(task.id);
  const state = cardState(task, today, waitsFor, dependenciesDone);
  // Start marks the task in progress.
  const startable = (state === "start" || state === "ready") && onStart;
  return (
    <div
      ref={ref}
      className={`review-draggable ${isDragSource ? "is-dragging" : ""} ${pending ? "is-pending" : ""} ${insert ? `is-insert-${insert}` : ""}`}
      data-state={state}
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
        aria-label={`${language === "zh" ? "移动事项" : "Move outcome"}: ${title}${pending ? `, ${text.updating}` : ""}`}
      >
        <GripVertical size={14} />
      </button>
      <OutcomeCard
        task={task}
        tasks={plan.tasks}
        scheduledIds={scheduledIds}
        today={today}
        language={language}
        pending={pending}
        waitsFor={waitsFor}
        dependenciesDone={dependenciesDone}
        untouched={lane === "parked"}
        onClick={() => editTask(task)}
      />
      <CompleteTaskButton
        task={task}
        language={language}
        disabled={busy || pending}
        onComplete={() => completeTask(task)}
      />
      {startable && (
        <button
          type="button"
          className="review-card-action"
          data-start-id={task.id}
          // A card whose drag waits still carries its old etag, so its write waits too.
          disabled={busy || pending}
          aria-label={`${text.start}: ${title}`}
          onClick={() => onStart(task)}
        >
          {text.start}
        </button>
      )}
    </div>
  );
}
