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
  MAX_LANE_TASKS,
  outcomeArea,
  outcomeColor,
  outcomeSteps,
  PARKED_LABEL,
  reviewLanes,
} from "./planning-outcomes";
import {
  moved,
  pendingTask,
  predictLaneOrder,
  predictStage,
  withStage,
} from "./plan-updates";
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
import { untouchedText } from "./weekly-review";
import { words } from "./i18n";
import type {
  Area,
  FlowDayPlan,
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
  managedLabels: PlanState["managedLabels"];
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
  /** In Parked: how long Todoist has not changed it, in place of the step counts. */
  untouched?: boolean;
  onClick: () => void;
}
/**
 * Title, area, and the step counts or, when the task waits or should start, one muted status in
 * their place: beside the area, or in a row of its own when it has two parts. A parked card says
 * how long it has been untouched instead of its counts. Only days past a deadline are drawn in
 * --plus-danger.
 */
export function OutcomeCard({
  task,
  tasks,
  managedLabels,
  scheduledIds,
  today,
  language,
  selected = false,
  pending = false,
  waitsFor,
  untouched = false,
  onClick,
}: OutcomeCardProps) {
  const steps = outcomeSteps(task, tasks, managedLabels);
  const planned = steps.filter((step) => scheduledIds.has(step.id)).length;
  const priority =
    task.priority > 1
      ? `P${5 - task.priority}`
      : language === "zh"
        ? "未设优先级"
        : "No priority";
  const title = displayedTitle(task.title);
  const state = today ? cardState(task, today, waitsFor) : undefined;
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
  const statusText = (
    <span
      className={`planning-outcome-status ${status.length > 1 ? "is-row" : ""}`}
      title={dated ? deadlineTitle(task.deadline, language) : undefined}
    >
      {status.map((part, index) => (
        <span key={index} className={part.quoted ? "has-quoted" : undefined}>
          {index > 0 && <span className="planning-outcome-separator"> · </span>}
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
  );
  return (
    <button
      type="button"
      className={`planning-outcome-card ${selected ? "is-selected" : ""}`}
      style={{ "--outcome-color": outcomeColor(task) } as CSSProperties}
      data-outcome-id={task.id}
      onClick={onClick}
      // The name replaces the content, so it carries the status and pending state too.
      aria-label={`${title}, ${priority}${spoken}${pending ? `, ${words(language).updating}` : ""}`}
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
          <strong className="planning-outcome-title" title={title}>
            {title}
          </strong>
          {pending && <PendingMark language={language} />}
        </span>
        <span className="planning-outcome-meta">
          <span className="planning-outcome-context">
            {outcomeArea(task, tasks, language)}
          </span>
          {!hasStatus ? (
            <span className="planning-outcome-counts">
              {language === "zh"
                ? `${steps.length} 个步骤 · 已安排 ${planned}`
                : `${steps.length} ${steps.length === 1 ? "step" : "steps"} · ${planned} planned`}
            </span>
          ) : (
            status.length < 2 && statusText
          )}
        </span>
        {status.length > 1 && statusText}
      </span>
    </button>
  );
}

interface Props {
  plan: PlanState;
  /** Each task's one lane, from boardLanes. */
  lanes: BoardLanes;
  days: FlowDayPlan[];
  area: Area | "all";
  currentDate: string;
  language: Language;
  busy: boolean;
  pending?: ReadonlySet<string>;
  actions: PlusActions;
  run: RunOperation;
  editTask: (task: PlanningTask) => void;
  completeTask: CompletePlanningTask;
  /**
   * One quiet line each, under the lanes so that nothing above them moves: a task that no longer waits
   * because what it waited for was deleted or left the list, told once.
   */
  dependencyNotices?: readonly string[];
}
/**
 * As many cards as Parked shows before "more", the most untouched: few, so that where the side
 * lanes sit above the stages a someday pile never pushes the stages out of view.
 */
const PARKED_SHOWN = 3;

/**
 * Start now, Waiting, Parked and the four stage lanes, with the same lanes and cards. Start now
 * and Waiting show only when they have cards and take no drops: a card dragged from Start now into
 * a stage lane takes that stage and is marked in progress in one write; one from Waiting takes only
 * the stage. Parked always shows and takes any card: it sets the card aside, and a card dragged out
 * of it into a stage lane takes that stage and is no longer set aside. Inside every lane a card
 * dropped on another card takes its place: the lane keeps that order in Todofy, and Tasks' order of
 * the moved card's siblings follows (not for Waiting and Parked).
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
  dependencyNotices = [],
}: Props) {
  const text = words(language);
  const board = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState("");
  // After a confirmed Start, focus moves on to the next card that can start, or to the board.
  const [focusAfter, setFocusAfter] = useState<{ id: string; next: string }>();
  // A card reordered in its lane keeps keyboard focus on its handle, though React moves its node.
  const [focusMoved, setFocusMoved] = useState<string>();
  // A reorder's request ID, reused when the same reorder is tried again.
  const reorderRequests = useRef(new Map<string, string>());
  // The drag instructions every handle names, in the board's own shadow root.
  const hintId = useId();
  // A drag speaks of card titles, lane names and positions.
  const plugins = useMemo(() => {
    const { startNow, waiting, parked } = words(language);
    const laneTitles: Record<string, string> = {
      start: startNow,
      waiting,
      parked,
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
  // Stage and Parked lanes accept a planning change. Start now and Waiting take no stage changes
  // and show only with cards.
  const columns: {
    id: LaneId;
    title: string;
    stage?: Exclude<Stage, "none">;
    label?: string;
  }[] = [
    { id: "start" as const, title: text.startNow },
    { id: "waiting" as const, title: text.waiting },
    { id: "parked" as const, title: text.parked, label: PARKED_LABEL },
    ...reviewLanes(language).map((lane) => ({
      id: lane.stage,
      title: lane.title,
      stage: lane.stage,
      label: plan.managedLabels.find((label) => label.role === lane.role)
        ?.label,
    })),
  ].filter(
    (column) =>
      (column.id !== "start" && column.id !== "waiting") ||
      shown(column.id).length,
  );
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

  /**
   * Moves a card from `from` to `to` in its lane, both positions in the whole lane: one
   * ReorderTasks with the lane's new order, at most Todofy's 100.
   */
  function reorder(task: PlanningTask, lane: LaneId, from: number, to: number) {
    const ids = lanes[lane].map((item) => item.id);
    let next = moved(ids, from, to);
    if (next.every((id, index) => id === ids[index])) return;
    if (next.length > MAX_LANE_TASKS) {
      if (next.indexOf(task.id) >= MAX_LANE_TASKS) return;
      next = next.slice(0, MAX_LANE_TASKS);
    }
    // Todoist's current positions are part of the key: once they changed elsewhere, so that
    // Todofy refuses the old request, the read that follows makes the next drop a new one.
    const key = [
      lane,
      task.id,
      next.join(","),
      lanes[lane].map((item) => item.childOrder).join(","),
    ].join("|");
    const requestId = reorderRequests.current.get(key) ?? crypto.randomUUID();
    reorderRequests.current.set(key, requestId);
    setFocusMoved(task.id);
    // The card shows in its new place at once and waits there until Todofy confirms.
    void run(
      async () => {
        const result = await actions.reorderTasks(
          next,
          task.id,
          lane,
          requestId,
        );
        reorderRequests.current.delete(key);
        return result;
      },
      {
        // A reorder changes the siblings' revisions too; their next writes need the returned etags.
        pending: next.map(pendingTask),
        predict: predictLaneOrder(lane, next),
      },
    );
  }

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
          if (start !== undefined && end !== undefined)
            reorder(task, from, start, end);
          return;
        }
        const column = columns.find((item) => item.id === to);
        if (!column || (!column.stage && to !== "parked")) return;
        const parking = to === "parked";
        const stage: Stage = column.stage ?? "none";
        // Start now is acknowledged by the drag: the stage and the in-progress label in one write.
        const active = from === "start" && !parking;
        // Parked's label goes with any move out of it; into it, the label alone does it all.
        const parked = parking ? true : from === "parked" ? false : undefined;
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
        // Acknowledged, a Start now card may leave the board, but not come straight back. Any other
        // card must land in the lane it was dropped on: one that would come straight back, or be
        // only a step of its outcome's card again, writes nothing.
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
        <div className="review-board-notices" role="status">
          {dependencyNotices.map((notice) => (
            <p key={notice}>{notice}</p>
          ))}
        </div>
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
                managedLabels={plan.managedLabels}
                scheduledIds={scheduledIds}
                today={currentDate}
                language={language}
                waitsFor={dependencyIndex(plan).waitingFor.get(task.id)}
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
  /** The label a drop writes; a drop on Start now or Waiting changes nothing. */
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
    // Start now and Waiting catch a drop without a label, which changes nothing, so that a card
    // let go over them goes back instead of into the lane its preview overlaps.
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
  // Parked shows its first cards; the rest wait behind "more".
  const [expanded, setExpanded] = useState(false);
  const cards =
    lane === "parked" && !expanded ? tasks.slice(0, PARKED_SHOWN) : tasks;
  const hidden = tasks.length - PARKED_SHOWN;
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
    // Start now and Waiting take no drops from other lanes, only their own cards' moves.
    accept:
      lane === "start" || lane === "waiting"
        ? (source) => source.data?.lane === lane
        : "review-outcome",
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
  const state = cardState(task, today, waitsFor);
  // Start marks the task in progress.
  const startable = state === "start" && onStart;
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
        managedLabels={plan.managedLabels}
        scheduledIds={scheduledIds}
        today={today}
        language={language}
        pending={pending}
        waitsFor={waitsFor}
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
