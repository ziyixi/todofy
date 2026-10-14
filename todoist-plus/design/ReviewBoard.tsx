import type { CSSProperties } from "react";
import {
  DragDropProvider,
  DragOverlay,
  useDraggable,
  useDroppable,
} from "@dnd-kit/react";
import { Flag, GripVertical, Star } from "lucide-react";
import { LANES, type Lane, type Outcome } from "./planning-model";
import "./review.css";

interface Props {
  outcomes: Outcome[];
  queues: Record<string, string[]>;
  area: "all" | "work" | "personal";
  onMove: (id: string, lane: Lane) => void;
  onEdit: (id: string) => void;
}

export function OutcomeCard({
  outcome,
  scheduled,
  selected = false,
  onClick,
}: {
  outcome: Outcome;
  scheduled: number;
  selected?: boolean;
  onClick: () => void;
}) {
  const done = outcome.steps.filter((step) => step.done).length;
  const priority =
    outcome.priority > 1 ? `P${5 - outcome.priority}` : "No priority";
  return (
    <button
      type="button"
      className={`planning-outcome-card ${selected ? "is-selected" : ""}`}
      style={{ "--outcome-color": outcome.color } as CSSProperties}
      data-outcome-id={outcome.id}
      onClick={onClick}
      aria-label={`${outcome.title}, ${priority}, ${done} of ${outcome.steps.length} steps complete, ${scheduled} scheduled`}
    >
      <span
        className="planning-priority-circle"
        data-priority={outcome.priority}
        title={priority}
        aria-hidden="true"
      />
      <span className="planning-outcome-content">
        <span className="planning-outcome-title-row">
          <strong className="planning-outcome-title" title={outcome.title}>
            {outcome.title}
          </strong>
          {outcome.bet && (
            <Star
              size={12}
              className="planning-outcome-bet"
              fill="currentColor"
              aria-label="Weekly bet"
            />
          )}
          {outcome.mustStart && (
            <Flag
              size={12}
              className="planning-outcome-start"
              aria-label="Must start"
            />
          )}
        </span>
        <span className="planning-outcome-meta">
          <span className="planning-outcome-context" title={outcome.context}>
            {outcome.context}
          </span>
          <span
            className="planning-outcome-counts"
            title={`${done} complete · ${scheduled} scheduled`}
          >
            {done}/{outcome.steps.length} · {scheduled} planned
          </span>
        </span>
      </span>
    </button>
  );
}

function DraggableOutcome({
  outcome,
  scheduled,
  onEdit,
}: {
  outcome: Outcome;
  scheduled: number;
  onEdit: Props["onEdit"];
}) {
  const { ref, handleRef, isDragSource } = useDraggable({
    id: `review-outcome:${outcome.id}`,
    type: "review-outcome",
    data: { outcomeId: outcome.id, lane: outcome.lane },
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
        aria-label={`Move outcome: ${outcome.title}`}
      >
        <GripVertical size={13} />
      </button>
      <OutcomeCard
        outcome={outcome}
        scheduled={scheduled}
        onClick={() => onEdit(outcome.id)}
      />
    </div>
  );
}

function ReviewLane({
  lane,
  outcomes,
  scheduledIds,
  onEdit,
}: {
  lane: (typeof LANES)[number];
  outcomes: Outcome[];
  scheduledIds: Set<string>;
  onEdit: Props["onEdit"];
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `review-lane:${lane.id}`,
    accept: "review-outcome",
    data: { lane: lane.id },
  });
  return (
    <section
      ref={ref}
      className={`review-lane ${isDropTarget ? "is-over" : ""}`}
      aria-label={lane.title}
      data-lane={lane.id}
    >
      <header className="review-lane-header">
        <h2>{lane.title}</h2>
        <span>{outcomes.length}</span>
      </header>
      <div className="review-lane-cards">
        {outcomes.map((outcome) => (
          <DraggableOutcome
            key={outcome.id}
            outcome={outcome}
            scheduled={
              outcome.steps.filter(
                (step) => !step.done && scheduledIds.has(step.id),
              ).length
            }
            onEdit={onEdit}
          />
        ))}
        {!outcomes.length && (
          <p className="review-lane-empty">Drop an outcome here</p>
        )}
      </div>
    </section>
  );
}

export function ReviewBoard({ outcomes, queues, area, onMove, onEdit }: Props) {
  const scheduledIds = new Set(Object.values(queues).flat());
  const visible = outcomes.filter(
    (outcome) => area === "all" || outcome.area === area,
  );
  return (
    <DragDropProvider
      onDragEnd={({ canceled, operation }) => {
        if (canceled) return;
        const source = operation.source?.data as
          { outcomeId?: string; lane?: Lane } | undefined;
        const target = operation.target?.data as { lane?: Lane } | undefined;
        if (source?.outcomeId && target?.lane && source.lane !== target.lane)
          onMove(source.outcomeId, target.lane);
      }}
    >
      <div className="review-board">
        <div className="review-lanes">
          {LANES.map((lane) => (
            <ReviewLane
              key={lane.id}
              lane={lane}
              outcomes={visible.filter((outcome) => outcome.lane === lane.id)}
              scheduledIds={scheduledIds}
              onEdit={onEdit}
            />
          ))}
        </div>
      </div>
      <DragOverlay dropAnimation={{ duration: 160, easing: "ease-out" }}>
        {(source) => {
          const outcome = outcomes.find(
            (item) => item.id === source.data?.outcomeId,
          );
          return outcome ? (
            <div className="review-drag-preview" aria-hidden="true" inert>
              <OutcomeCard
                outcome={outcome}
                scheduled={
                  outcome.steps.filter(
                    (step) => !step.done && scheduledIds.has(step.id),
                  ).length
                }
                onClick={() => {}}
              />
            </div>
          ) : null;
        }}
      </DragOverlay>
    </DragDropProvider>
  );
}
