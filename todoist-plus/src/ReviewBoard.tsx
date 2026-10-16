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
  outcomeArea,
  outcomeColor,
  outcomeSteps,
  reviewLanes,
} from "./planning-outcomes";
import { pendingTask, predictStage, withStage } from "./plan-updates";
import {
  boardLanes,
  cardState,
  cardStatus,
  statusLine,
  type BoardLanes,
  type LaneId,
} from "./review-lanes";
import { PendingMark } from "./StatusMarks";
import { words } from "./i18n";
import type {
  Area,
  FlowDayPlan,
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
  onClick: () => void;
}
/**
 * Title, area, and the step counts or, when the task waits or should start, one muted status in
 * their place: beside the area, or in a row of its own when it has two parts. Only days past a
 * deadline are drawn in --plus-danger.
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
  const status =
    today && state ? cardStatus(task, state, today, language, waitsFor) : [];
  const line = statusLine(status);
  // Screen readers hear the status with the part of the deadline it does not already say.
  const spoken = line
    ? `, ${line}${task.deadline ? spokenDeadline({ text: line }, task.deadline, language) : ""}`
    : "";
  const statusText = (
    <span
      className={`planning-outcome-status ${status.length > 1 ? "is-row" : ""}`}
      title={task.deadline ? deadlineTitle(task.deadline, language) : undefined}
    >
      {status.map((part, index) => (
        <span key={index}>
          {index > 0 && <span className="planning-outcome-separator"> · </span>}
          {part.text}
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
        <span className={`planning-outcome-meta ${state ? "has-status" : ""}`}>
          <span className="planning-outcome-context">
            {outcomeArea(task, tasks, language)}
          </span>
          {!state ? (
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
}
/**
 * Start now, Waiting and the four stage lanes, with the same lanes and cards. Start now and
 * Waiting show only when they have cards and take no drops: a card dragged from Start now into a
 * stage lane takes that stage and is marked in progress in one write; one from Waiting takes only
 * the stage.
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
  const columns = [
    { id: "start" as LaneId, title: text.startNow },
    { id: "waiting" as LaneId, title: text.waiting },
    ...reviewLanes(language).map((lane) => ({
      id: lane.stage as LaneId,
      title: lane.title,
      stage: lane.stage,
      label: plan.managedLabels.find((label) => label.role === lane.role)
        ?.label,
    })),
  ].filter((column) => "stage" in column || shown(column.id).length);
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
        const stage = operation.target?.data?.stage as Stage | undefined;
        if (!task || !stage || from === stage) return;
        // Start now is acknowledged by the drag: the stage and the in-progress label in one write.
        const active = from === "start" && marks;
        // A step that takes its outcome's own stage is a step of that card, not a card there, so
        // Waiting or Start now would show it again at once: such a drop writes nothing.
        const after = boardLanes(
          withStage(plan, task.id, stage, active),
          currentDate,
        );
        if (from && after[from].some((item) => item.id === task.id)) return;
        // The card moves at once and waits in its new lane until Todoist confirms.
        void run(
          () =>
            actions.updateTask(task, active ? { stage, active } : { stage }),
          {
            pending: [pendingTask(task.id)],
            predict: predictStage(task.id, stage, active),
          },
        );
      }}
    >
      <div className="review-board" ref={board}>
        <div className="review-lanes" data-lanes={columns.length}>
          {columns.map((column) => (
            <ReviewLane
              key={column.id}
              lane={column.id}
              stage={"stage" in column ? column.stage : undefined}
              title={column.title}
              label={"label" in column ? column.label : undefined}
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
  /** A stage lane's stage; a drop on Start now or Waiting changes nothing. */
  stage?: Exclude<Stage, "none">;
  title: string;
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
    // Start now and Waiting catch a drop without a stage, which changes nothing, so that a card
    // let go over them goes back instead of into the lane its preview overlaps.
    disabled: busy || Boolean(stage && !label),
    data: { stage },
  });
  return (
    <section
      ref={ref}
      className={`review-lane ${isDropTarget && stage ? "is-over" : ""}`}
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
        {tasks.map((task) => (
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
            {language === "zh" ? "拖入事项" : "Drop an outcome here"}
          </p>
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
