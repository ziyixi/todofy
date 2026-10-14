import { useState, type CSSProperties } from "react";
import {
  DragDropProvider,
  DragOverlay,
  useDraggable,
  useDroppable,
} from "@dnd-kit/react";
import { ChevronLeft, ChevronRight, GripVertical, X } from "lucide-react";
import { OutcomeCard } from "./ReviewBoard";
import {
  CURRENT_WEEK,
  TODAY,
  findStep,
  minutesLabel,
  shiftWeek,
  weekDates,
  type Area,
  type Outcome,
  type Step,
} from "./planning-model";
import "./week.css";

interface Props {
  outcomes: Outcome[];
  queues: Record<string, string[]>;
  week: string;
  onWeekChange: (week: string) => void;
  onMove: (
    id: string,
    date: string,
    sourceDate?: string,
    beforeId?: string,
  ) => void;
  onRemove: (id: string, date: string) => void;
  onEdit: (id: string) => void;
}

export function PlanningWeek({
  outcomes,
  queues,
  week,
  onWeekChange,
  onMove,
  onRemove,
  onEdit,
}: Props) {
  const committed = outcomes.filter((outcome) => outcome.lane === "committed");
  const [area, setArea] = useState<Area | "all">("all");
  const [selectedId, setSelectedId] = useState(
    () =>
      committed.find((outcome) => outcome.id === "website")?.id ??
      committed[0]?.id ??
      "",
  );
  const [selectedDate, setSelectedDate] = useState(TODAY);
  const dates = weekDates(week);
  const selected = committed.find((outcome) => outcome.id === selectedId);
  const shown =
    area === "all"
      ? committed
      : committed.filter((outcome) => outcome.area === area);
  const dayIndex = dates.includes(selectedDate)
    ? dates.indexOf(selectedDate)
    : Math.max(0, dates.indexOf(TODAY));
  const windowStart = Math.min(Math.max(0, dayIndex - 1), 4);
  const range = new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).formatRange(
    new Date(`${dates[0]}T12:00:00Z`),
    new Date(`${dates[6]}T12:00:00Z`),
  );
  const scheduledIds = new Set(dates.flatMap((date) => queues[date] ?? []));
  function selectArea(next: Area | "all") {
    setArea(next);
    if (next !== "all" && selected?.area !== next)
      setSelectedId(
        committed.find((outcome) => outcome.area === next)?.id ?? "",
      );
  }
  return (
    <DragDropProvider
      onDragEnd={(event) => {
        if (event.canceled) return;
        const source = event.operation.source?.data as
          { stepId?: string; sourceDate?: string } | undefined;
        const target = event.operation.target?.data as
          { date?: string; beforeId?: string } | undefined;
        if (
          source?.stepId &&
          target?.date &&
          source.stepId !== target.beforeId
        ) {
          onMove(
            source.stepId,
            target.date,
            source.sourceDate,
            target.beforeId,
          );
          setSelectedDate(target.date);
        }
      }}
    >
      <section className="planning-week" aria-label="Weekly planning">
        <header className="planning-commitment-heading">
          <div>
            <h2>Committed</h2>
            <span>
              {committed.filter((outcome) => outcome.area === "work").length}/5
              work ·{" "}
              {
                committed.filter((outcome) => outcome.area === "personal")
                  .length
              }
              /3 personal
            </span>
          </div>
          <div
            className="planning-area-filter"
            role="tablist"
            aria-label="Commitment area"
          >
            {(["all", "work", "personal"] as const).map((value) => (
              <button
                key={value}
                role="tab"
                aria-selected={area === value}
                onClick={() => selectArea(value)}
              >
                {value === "all"
                  ? `All ${committed.length}`
                  : value === "work"
                    ? "Work"
                    : "Personal"}
              </button>
            ))}
          </div>
        </header>
        <div className="planning-commitment-grid">
          {shown.map((outcome) => (
            <OutcomeCard
              key={outcome.id}
              outcome={outcome}
              scheduled={
                outcome.steps.filter(
                  (step) => !step.done && scheduledIds.has(step.id),
                ).length
              }
              selected={selected?.id === outcome.id}
              onClick={() =>
                setSelectedId(selectedId === outcome.id ? "" : outcome.id)
              }
            />
          ))}
        </div>
        {selected ? (
          <section
            className="planning-step-tray"
            aria-label={`Next steps: ${selected.title}`}
            style={{ "--outcome-color": selected.color } as CSSProperties}
          >
            <header>
              <div>
                <span>Next steps</span>
                <strong>{selected.title}</strong>
              </div>
              <button onClick={() => onEdit(selected.id)}>Edit outcome</button>
            </header>
            <div className="planning-tray-steps">
              {selected.steps
                .filter((step) => !step.done)
                .map((step) => (
                  <TrayStep
                    key={step.id}
                    step={step}
                    outcome={selected}
                    dates={dates}
                    queues={queues}
                    onEdit={onEdit}
                  />
                ))}
            </div>
          </section>
        ) : (
          <p className="planning-step-tray-empty">
            Choose an outcome above to arrange its next steps.
          </p>
        )}
        <section className="planning-calendar" aria-label="Week schedule">
          <header className="planning-calendar-heading">
            <nav aria-label="Choose week">
              <button
                aria-label="Previous week"
                onClick={() => onWeekChange(shiftWeek(week, -1))}
              >
                <ChevronLeft size={18} />
              </button>
              <strong>{range}</strong>
              <button
                aria-label="Next week"
                onClick={() => onWeekChange(shiftWeek(week, 1))}
              >
                <ChevronRight size={18} />
              </button>
              <button
                className="planning-current-week"
                disabled={week === CURRENT_WEEK}
                onClick={() => onWeekChange(CURRENT_WEEK)}
              >
                This week
              </button>
            </nav>
            <span>Drag steps into a day</span>
          </header>
          <div
            className="planning-compact-days"
            role="tablist"
            aria-label="Choose day"
          >
            {dates.map((date, index) => (
              <DatePicker
                key={date}
                date={date}
                selected={index === dayIndex}
                onSelect={() => setSelectedDate(date)}
              />
            ))}
          </div>
          <div className="planning-calendar-columns">
            {dates.map((date, index) => (
              <CalendarDay
                key={date}
                date={date}
                ids={queues[date] ?? []}
                outcomes={outcomes}
                selected={index === dayIndex}
                inWindow={index >= windowStart && index < windowStart + 3}
                onSelect={() => setSelectedDate(date)}
                onRemove={onRemove}
                onEdit={onEdit}
              />
            ))}
          </div>
        </section>
      </section>
      <DragOverlay dropAnimation={{ duration: 160, easing: "ease-out" }}>
        {(source) => {
          const match = findStep(outcomes, String(source.data?.stepId ?? ""));
          if (!match) return null;
          return (
            <div
              className="planning-step-overlay"
              style={
                { "--outcome-color": match.outcome.color } as CSSProperties
              }
            >
              <strong>{match.step.title}</strong>
              <small>
                {match.outcome.title} · {minutesLabel(match.step.minutes)}
              </small>
            </div>
          );
        }}
      </DragOverlay>
    </DragDropProvider>
  );
}

function TrayStep({
  step,
  outcome,
  dates,
  queues,
  onEdit,
}: {
  step: Step;
  outcome: Outcome;
  dates: string[];
  queues: Record<string, string[]>;
  onEdit: Props["onEdit"];
}) {
  const { ref, handleRef, isDragSource } = useDraggable({
    id: `tray:${step.id}`,
    type: "planning-step",
    data: { stepId: step.id },
  });
  const scheduled = dates.filter((date) => queues[date]?.includes(step.id));
  return (
    <article
      ref={ref}
      className={`planning-tray-step ${isDragSource ? "is-dragging" : ""}`}
      style={{ "--outcome-color": outcome.color } as CSSProperties}
      data-step-id={step.id}
    >
      <button
        ref={handleRef}
        className="planning-drag-handle"
        aria-label={`Drag step: ${step.title}`}
      >
        <GripVertical size={15} />
      </button>
      <button
        className="planning-step-title"
        onClick={() => onEdit(outcome.id)}
      >
        <span>{step.title}</span>
        <small>
          {minutesLabel(step.minutes)}
          {scheduled.length > 0 && ` · ${scheduled.map(shortDay).join(", ")}`}
        </small>
      </button>
    </article>
  );
}

function DatePicker({
  date,
  selected,
  onSelect,
}: {
  date: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `week-picker:${date}`,
    accept: "planning-step",
    collisionPriority: 2,
    data: { date },
  });
  return (
    <button
      ref={ref}
      role="tab"
      aria-label={`Show ${date}`}
      aria-selected={selected}
      className={isDropTarget ? "is-over" : ""}
      onClick={onSelect}
    >
      <span>{shortDay(date)}</span>
      <strong>{new Date(`${date}T12:00:00Z`).getUTCDate()}</strong>
    </button>
  );
}

function CalendarDay({
  date,
  ids,
  outcomes,
  selected,
  inWindow,
  onSelect,
  onRemove,
  onEdit,
}: {
  date: string;
  ids: string[];
  outcomes: Outcome[];
  selected: boolean;
  inWindow: boolean;
  onSelect: () => void;
  onRemove: Props["onRemove"];
  onEdit: Props["onEdit"];
}) {
  const { ref, isDropTarget } = useDroppable({
    id: `week-day:${date}`,
    accept: "planning-step",
    collisionPriority: 1,
    data: { date },
  });
  const minutes = ids.reduce(
    (total, id) => total + (findStep(outcomes, id)?.step.minutes ?? 0),
    0,
  );
  return (
    <section
      className={`planning-calendar-day ${date === TODAY ? "is-today" : ""} ${selected ? "is-selected" : ""} ${inWindow ? "is-window" : ""} ${isDropTarget ? "is-over" : ""}`}
      data-date={date}
    >
      <button className="planning-day-heading" onClick={onSelect}>
        <span>{shortDay(date)}</span>
        <strong>{new Date(`${date}T12:00:00Z`).getUTCDate()}</strong>
        <small>{minutes > 0 ? minutesLabel(minutes) : "—"}</small>
      </button>
      <div ref={ref} className="planning-day-body">
        {ids.map((id) => (
          <CalendarStep
            key={id}
            id={id}
            date={date}
            match={findStep(outcomes, id)}
            onRemove={onRemove}
            onEdit={onEdit}
          />
        ))}
        <EndDrop date={date} empty={ids.length === 0} />
      </div>
    </section>
  );
}

function CalendarStep({
  id,
  date,
  match,
  onRemove,
  onEdit,
}: {
  id: string;
  date: string;
  match: ReturnType<typeof findStep>;
  onRemove: Props["onRemove"];
  onEdit: Props["onEdit"];
}) {
  const { ref, handleRef, isDragSource } = useDraggable({
    id: `week-step:${date}:${id}`,
    type: "planning-step",
    disabled: match?.step.done === true,
    data: { stepId: id, sourceDate: date },
  });
  const { ref: dropRef, isDropTarget } = useDroppable({
    id: `week-before:${date}:${id}`,
    accept: "planning-step",
    collisionPriority: 2,
    data: { date, beforeId: id },
  });
  const title = match?.step.title ?? "Step unavailable";
  return (
    <article
      ref={(element) => {
        ref(element);
        dropRef(element);
      }}
      className={`planning-calendar-step ${isDragSource ? "is-dragging" : ""} ${isDropTarget && !isDragSource ? "is-insert" : ""} ${match?.step.done ? "is-done" : ""}`}
      data-step-id={id}
      style={
        { "--outcome-color": match?.outcome.color ?? "#888" } as CSSProperties
      }
    >
      <div className="planning-calendar-step-top">
        <button
          ref={handleRef}
          className="planning-drag-handle"
          disabled={match?.step.done === true}
          aria-label={`Drag scheduled step: ${title}`}
        >
          <GripVertical size={14} />
        </button>
        <button
          className="planning-step-title"
          disabled={!match}
          onClick={() => match && onEdit(match.outcome.id)}
        >
          {title}
        </button>
        <button
          className="planning-step-remove"
          aria-label={`Remove from ${date}: ${title}`}
          onClick={() => onRemove(id, date)}
        >
          <X size={13} />
        </button>
      </div>
      <div className="planning-calendar-step-meta">
        <span>{match?.outcome.title ?? "Unknown outcome"}</span>
        <strong>{match ? minutesLabel(match.step.minutes) : "?"}</strong>
      </div>
    </article>
  );
}

function EndDrop({ date, empty }: { date: string; empty: boolean }) {
  const { ref, isDropTarget } = useDroppable({
    id: `week-end:${date}`,
    accept: "planning-step",
    collisionPriority: 2,
    data: { date },
  });
  return (
    <div
      ref={ref}
      className={`planning-day-end ${isDropTarget ? "is-over" : ""}`}
    >
      {empty ? "Drop a step" : "+"}
    </div>
  );
}

function shortDay(date: string): string {
  return new Intl.DateTimeFormat("en", {
    weekday: "short",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00Z`));
}
