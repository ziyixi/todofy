import type { CSSProperties } from "react";
import {
  DragDropProvider,
  DragOverlay,
  useDraggable,
  useDroppable,
} from "@dnd-kit/react";
import { Flag, GripVertical } from "lucide-react";
import { displayedTitle, effectiveArea } from "./domain";
import {
  outcomeArea,
  outcomeColor,
  outcomeSteps,
  planningOutcomes,
  reviewLanes,
} from "./planning-outcomes";
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
  language: Language;
  selected?: boolean;
  onClick: () => void;
}
export function OutcomeCard({
  task,
  tasks,
  managedLabels,
  scheduledIds,
  language,
  selected = false,
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
  return (
    <button
      type="button"
      className={`planning-outcome-card ${selected ? "is-selected" : ""}`}
      style={{ "--outcome-color": outcomeColor(task) } as CSSProperties}
      data-outcome-id={task.id}
      onClick={onClick}
      aria-label={`${title}, ${priority}`}
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
          {task.mustStart && (
            <Flag
              size={12}
              className="planning-outcome-start"
              aria-label={
                language === "zh" ? "已到启动窗口" : "Start window open"
              }
            />
          )}
        </span>
        <span className="planning-outcome-meta">
          <span className="planning-outcome-context">
            {outcomeArea(task, tasks, language)}
          </span>
          <span className="planning-outcome-counts">
            {steps.length} {language === "zh" ? "下一步" : "steps"} · {planned}{" "}
            {language === "zh" ? "已安排" : "planned"}
          </span>
        </span>
      </span>
    </button>
  );
}

interface Props {
  plan: PlanState;
  days: FlowDayPlan[];
  area: Area | "all";
  language: Language;
  busy: boolean;
  actions: PlusActions;
  run: RunOperation;
  editTask: (task: PlanningTask) => void;
  onLabels?: () => void;
}
export function ReviewBoard({
  plan,
  days,
  area,
  language,
  busy,
  actions,
  run,
  editTask,
  onLabels,
}: Props) {
  const scheduledIds = new Set(
    days.flatMap((day) =>
      day.taskIds.filter((id) => !day.completedTaskIds.includes(id)),
    ),
  );
  const outcomes = planningOutcomes(plan.tasks, plan.managedLabels).filter(
    (task) => area === "all" || effectiveArea(task, plan.tasks) === area,
  );
  return (
    <DragDropProvider
      onDragEnd={({ canceled, operation }) => {
        if (canceled) return;
        const task = operation.source?.data?.task as PlanningTask | undefined;
        const stage = operation.target?.data?.stage as Stage | undefined;
        if (task && stage && task.stage !== stage)
          void run(() => actions.updateTask(task, { stage }));
      }}
    >
      <div className="review-board">
        <div className="review-lanes">
          {reviewLanes(language).map((lane) => {
            const label = plan.managedLabels.find(
              (label) => label.role === lane.role,
            )?.label;
            return (
              <ReviewLane
                key={lane.stage}
                stage={lane.stage}
                title={lane.title}
                label={label}
                tasks={outcomes.filter((task) => task.stage === lane.stage)}
                plan={plan}
                scheduledIds={scheduledIds}
                language={language}
                busy={busy}
                editTask={editTask}
                onLabels={onLabels}
              />
            );
          })}
        </div>
      </div>
      <DragOverlay dropAnimation={{ duration: 160, easing: "ease-out" }}>
        {(source) => {
          const task = source.data?.task as PlanningTask | undefined;
          return task ? (
            <div className="review-drag-preview" aria-hidden="true" inert>
              <OutcomeCard
                task={task}
                tasks={plan.tasks}
                managedLabels={plan.managedLabels}
                scheduledIds={scheduledIds}
                language={language}
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
  stage,
  title,
  label,
  tasks,
  plan,
  scheduledIds,
  language,
  busy,
  editTask,
  onLabels,
}: {
  stage: Stage;
  title: string;
  label?: string;
  tasks: PlanningTask[];
  plan: PlanState;
  scheduledIds: Set<string>;
  language: Language;
  busy: boolean;
  editTask: Props["editTask"];
  onLabels?: () => void;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `review-lane:${stage}`,
    accept: "review-outcome",
    disabled: busy || !label,
    data: { stage },
  });
  return (
    <section
      ref={ref}
      className={`review-lane ${isDropTarget ? "is-over" : ""}`}
      aria-label={title}
      data-lane={stage}
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
      {!label && (
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
            plan={plan}
            scheduledIds={scheduledIds}
            language={language}
            busy={busy}
            editTask={editTask}
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
  plan,
  scheduledIds,
  language,
  busy,
  editTask,
}: {
  task: PlanningTask;
  plan: PlanState;
  scheduledIds: Set<string>;
  language: Language;
  busy: boolean;
  editTask: Props["editTask"];
}) {
  const { ref, handleRef, isDragSource } = useDraggable({
    id: `review-outcome:${task.id}`,
    type: "review-outcome",
    disabled: busy,
    data: { task },
  });
  return (
    <div
      ref={ref}
      className={`review-draggable ${isDragSource ? "is-dragging" : ""}`}
    >
      <button
        ref={handleRef}
        type="button"
        className="review-drag-handle"
        disabled={busy}
        aria-label={`${language === "zh" ? "移动事项" : "Move outcome"}: ${displayedTitle(task.title)}`}
      >
        <GripVertical size={13} />
      </button>
      <OutcomeCard
        task={task}
        tasks={plan.tasks}
        managedLabels={plan.managedLabels}
        scheduledIds={scheduledIds}
        language={language}
        onClick={() => editTask(task)}
      />
    </div>
  );
}
