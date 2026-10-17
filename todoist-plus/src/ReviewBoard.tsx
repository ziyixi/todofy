import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  DragDropProvider,
  DragOverlay,
  useDraggable,
  useDroppable,
} from "@dnd-kit/react";
import { GripVertical } from "lucide-react";
import { displayedTitle, effectiveArea } from "./domain";
import { canMarkActive, deadlineTitle, spokenDeadline } from "./deadlines";
import { dependencyIndex } from "./dependencies";
import {
  canPark,
  outcomeArea,
  outcomeColor,
  outcomeSteps,
  PARKED_LABEL,
  reviewLanes,
} from "./planning-outcomes";
import { pendingTask, predictStage, withStage } from "./plan-updates";
import {
  boardLanes,
  cardState,
  cardStatus,
  statusLine,
  type BoardLanes,
} from "./review-lanes";
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
      <span
        className="planning-priority-circle"
        data-priority={task.priority}
        title={priority}
        aria-hidden="true"
      />
      <span className="planning-outcome-content">
        <span className="planning-outcome-title-row">
          <strong className="planning-outcome-title" title={title}>
            {title}
          </strong>
          {pending && <PendingMark language={language} />}
        </span>
        <span
          className={`planning-outcome-meta ${hasStatus ? "has-status" : ""}`}
        >
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
  onLabels?: () => void;
  /**
   * One quiet line each, under the lanes so that nothing above them moves: a task that no longer waits
   * because what it waited for was deleted or left the list, told once.
   */
  dependencyNotices?: readonly string[];
}
/** As many cards as Parked shows before "more", the weekly review's Someday count. */
const PARKED_SHOWN = 10;

/**
 * Start now, Waiting, Parked and the four stage lanes, with the same lanes and cards. Start now
 * and Waiting show only when they have cards and take no drops: a card dragged from Start now into
 * a stage lane takes that stage and is marked in progress in one write; one from Waiting takes only
 * the stage. Parked, while the account has the label, always shows and takes any card: it sets the
 * card aside, and a card dragged out of it into a stage lane takes that stage without the label.
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
  onLabels,
  dependencyNotices = [],
}: Props) {
  const text = words(language);
  const board = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState("");
  // After a confirmed Start, focus moves on to the next card that can start, or to the board.
  const [focusAfter, setFocusAfter] = useState<{ id: string; next: string }>();
  const scheduledIds = new Set(
    days.flatMap((day) =>
      day.taskIds.filter((id) => !day.completedTaskIds.includes(id)),
    ),
  );
  const marks = canMarkActive(plan);
  const shown = (id: LaneId) =>
    lanes[id].filter(
      (task) => area === "all" || effectiveArea(task, plan.tasks) === area,
    );
  // A lane takes drops when it writes a label: Parked's, or a stage lane's bound one. Start now
  // and Waiting take none and show only with cards; every other lane always shows.
  const columns: {
    id: LaneId;
    title: string;
    stage?: Exclude<Stage, "none">;
    label?: string;
  }[] = [
    { id: "start" as const, title: text.startNow },
    { id: "waiting" as const, title: text.waiting },
    ...(canPark(plan)
      ? [{ id: "parked" as const, title: text.parked, label: PARKED_LABEL }]
      : []),
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
      onDragEnd={({ canceled, operation }) => {
        if (canceled) return;
        const task = operation.source?.data?.task as PlanningTask | undefined;
        const from = operation.source?.data?.lane as LaneId | undefined;
        const to = operation.target?.data?.lane as LaneId | undefined;
        const column = columns.find((item) => item.id === to);
        if (!task || !from || !to || from === to || !column?.label) return;
        const parking = to === "parked";
        const stage: Stage = column.stage ?? "none";
        // Start now is acknowledged by the drag: the stage and the in-progress label in one write.
        const active = from === "start" && marks && !parking;
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
        <div className="review-lanes" data-lanes={columns.length}>
          {columns.map((column) => (
            <ReviewLane
              key={column.id}
              lane={column.id}
              stage={column.stage}
              title={column.title}
              label={column.label}
              tasks={shown(column.id)}
              plan={plan}
              scheduledIds={scheduledIds}
              today={currentDate}
              language={language}
              busy={busy}
              pending={pending}
              editTask={editTask}
              onStart={marks ? (task) => void start(task) : undefined}
              onLabels={onLabels}
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
      <DragOverlay dropAnimation={{ duration: 160, easing: "ease-out" }}>
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
  plan,
  scheduledIds,
  today,
  language,
  busy,
  pending,
  editTask,
  onStart,
  onLabels,
}: {
  lane: LaneId;
  /** A stage lane's stage. */
  stage?: Exclude<Stage, "none">;
  title: string;
  /** The label a drop writes; a drop on Start now or Waiting changes nothing. */
  label?: string;
  tasks: PlanningTask[];
  plan: PlanState;
  scheduledIds: Set<string>;
  today: string;
  language: Language;
  busy: boolean;
  pending?: ReadonlySet<string>;
  editTask: Props["editTask"];
  onStart?: (task: PlanningTask) => void;
  onLabels?: () => void;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `review-lane:${lane}`,
    accept: "review-outcome",
    // Start now and Waiting catch a drop without a label, which changes nothing, so that a card
    // let go over them goes back instead of into the lane its preview overlaps.
    disabled: busy || Boolean(stage && !label),
    data: { stage, lane },
  });
  const text = words(language);
  // Parked shows its first cards; the rest wait behind "more".
  const [expanded, setExpanded] = useState(false);
  const cards =
    lane === "parked" && !expanded ? tasks.slice(0, PARKED_SHOWN) : tasks;
  const hidden = tasks.length - PARKED_SHOWN;
  return (
    <section
      ref={ref}
      className={`review-lane ${isDropTarget && label ? "is-over" : ""}`}
      aria-label={title}
      data-lane={lane}
      // A jump from Focus or the weekly review focuses the lane.
      tabIndex={-1}
    >
      <header className="review-lane-header">
        <h2>{title}</h2>
        <span>{tasks.length}</span>
        {label && (
          <small
            title={`${language === "zh" ? "Todoist 标签" : "Todoist label"}: ${label}`}
          >
            @{label}
          </small>
        )}
      </header>
      {stage && !label && (
        <div className="review-missing-label">
          <p>
            {language === "zh"
              ? "先选择这列对应的标签"
              : "Choose a label for this column"}
          </p>
          {onLabels && (
            <button onClick={onLabels}>
              {language === "zh" ? "配置标签" : "Configure labels"}
            </button>
          )}
        </div>
      )}
      <div className="review-lane-cards">
        {cards.map((task) => (
          <DraggableOutcome
            key={task.id}
            task={task}
            lane={lane}
            plan={plan}
            scheduledIds={scheduledIds}
            today={today}
            language={language}
            busy={busy}
            pending={pending?.has(pendingTask(task.id)) ?? false}
            editTask={editTask}
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
  plan,
  scheduledIds,
  today,
  language,
  busy,
  pending,
  editTask,
  onStart,
}: {
  task: PlanningTask;
  lane: LaneId;
  plan: PlanState;
  scheduledIds: Set<string>;
  today: string;
  language: Language;
  busy: boolean;
  pending: boolean;
  editTask: Props["editTask"];
  onStart?: (task: PlanningTask) => void;
}) {
  const { ref, handleRef, isDragSource } = useDraggable({
    id: `review-outcome:${task.id}`,
    type: "review-outcome",
    disabled: busy || pending,
    data: { task, lane },
  });
  const text = words(language);
  const title = displayedTitle(task.title);
  const waitsFor = dependencyIndex(plan).waitingFor.get(task.id);
  const state = cardState(task, today, waitsFor);
  // Start marks the task in progress, which only an account with the literal label can.
  const startable = state === "start" && onStart;
  return (
    <div
      ref={ref}
      className={`review-draggable ${isDragSource ? "is-dragging" : ""} ${pending ? "is-pending" : ""}`}
      data-state={state}
      aria-busy={pending || undefined}
    >
      <button
        ref={handleRef}
        type="button"
        className="review-drag-handle"
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
