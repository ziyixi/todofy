import type { ReactNode } from "react";
import {
  CalendarDays,
  Check,
  Circle,
  Flag,
  GripVertical,
  Repeat2,
  Trash2,
} from "lucide-react";
import type { Task } from "../api";
import { dateLabel } from "../dates";
import { TaskRowDropZones, useTaskDrag } from "./TaskDrag";

export function TaskChildRow({
  child,
  peers,
  busy,
  today,
  onOpen,
  onComplete,
  onDelete,
  confirmation,
}: {
  child: Task;
  peers: readonly Task[];
  busy: boolean;
  today: string;
  onOpen: () => void;
  onComplete: () => void;
  onDelete: () => void;
  confirmation: ReactNode;
}) {
  const drag = useTaskDrag(child, busy);
  return (
    <div
      ref={drag.ref}
      data-task-id={child.id}
      className={`task-child-row ${child.completed ? "is-completed" : ""} ${drag.isDragSource ? "is-dragging" : ""}`}
    >
      <TaskRowDropZones task={child} peers={peers} inside={false} busy={busy} />
      <button
        ref={drag.handleRef}
        type="button"
        className="child-drag"
        disabled={busy}
        aria-label={`Drag ${child.title}`}
        title="Drag to reorder"
      >
        <GripVertical size={14} />
      </button>
      <button
        type="button"
        className={`complete-button priority-${child.priority}`}
        aria-label={`${child.completed ? "Reopen" : "Complete"} ${child.title}`}
        disabled={busy}
        onClick={onComplete}
      >
        {child.completed ? (
          <Check size={13} />
        ) : (
          <>
            <Circle size={18} />
            <Check size={11} className="complete-hover-check" aria-hidden />
          </>
        )}
      </button>
      <button
        type="button"
        className="task-child-title"
        aria-label={child.title}
        onClick={onOpen}
      >
        <span>{child.title}</span>
        {(child.dueDate || child.deadline || child.recurrence) && (
          <span className="task-child-meta">
            {child.dueDate && (
              <span
                className={
                  child.dueDate < today && !child.completed
                    ? "child-overdue"
                    : ""
                }
              >
                <CalendarDays size={11} />
                {dateLabel(child.dueDate, today)}
              </span>
            )}
            {child.recurrence && <Repeat2 size={11} aria-label="Repeating" />}
            {child.deadline && (
              <span>
                <Flag size={11} />
                {dateLabel(child.deadline, today)}
              </span>
            )}
          </span>
        )}
      </button>
      {child.kind === "step" && (
        <span className="child-estimate">
          {child.durationMinutes ? `${child.durationMinutes}m` : "No estimate"}
        </span>
      )}
      <button
        type="button"
        className="icon-button child-delete"
        aria-label={`Delete ${child.kind === "step" ? "step" : "subtask"} ${child.title}`}
        disabled={busy}
        onClick={onDelete}
      >
        <Trash2 size={14} />
      </button>
      {confirmation}
    </div>
  );
}
