import { useRef, useState } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import {
  CalendarDays,
  Check,
  ChevronRight,
  Circle,
  Flag,
  GripVertical,
  MoreHorizontal,
  Repeat2,
  Tag,
  Timer,
} from "lucide-react";
import { type Catalog, type Task, describeError } from "../api";
import { dateLabel } from "../dates";
import { repeatLabel } from "../recurrence-controls";
import { Dialog } from "./Dialog";
import {
  TaskMenuChooser,
  TaskMenuItems,
  type TaskMenuActions,
  type TaskMenuProperty,
} from "./TaskMenu";

export function TaskRow({
  task,
  catalog,
  today,
  parentTitle,
  busyIds,
  selected,
  onSelect,
  onOpen,
  onComplete,
  onReorder,
  draggedId,
  overId,
  setDraggedId,
  setOverId,
  menuActions,
}: {
  task: Task;
  catalog: Catalog;
  today: string;
  parentTitle?: string;
  busyIds: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onComplete: (task: Task) => void;
  onReorder: (id: string, before: Task) => void;
  draggedId: string;
  overId: string;
  setDraggedId: (id: string) => void;
  setOverId: (id: string) => void;
  menuActions?: TaskMenuActions;
}) {
  const project = catalog.projects.find((item) => item.id === task.projectId);
  const due = task.dueDate || task.dueDatetime.slice(0, 10);
  const more = useRef<HTMLButtonElement>(null);
  const contextAnchor = useRef<HTMLSpanElement>(null);
  const origin = useRef<"context" | "more">("more");
  const [contextPoint, setContextPoint] = useState({ x: 0, y: 0 });
  const [chooser, setChooser] = useState<{
    property: TaskMenuProperty;
    anchor: HTMLElement;
  }>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const deleteRequest = useRef("");
  function openProperty(property: TaskMenuProperty) {
    const anchor =
      origin.current === "context" ? contextAnchor.current : more.current;
    if (anchor) setChooser({ property, anchor });
  }
  async function remove() {
    if (!menuActions) return;
    setDeleting(true);
    setDeleteError("");
    try {
      await menuActions.deleteTask(task, deleteRequest.current);
      setConfirmDelete(false);
    } catch (reason) {
      setDeleteError(describeError(reason));
    } finally {
      setDeleting(false);
    }
  }
  const menuProps = {
    task,
    catalog,
    busy: busyIds.has(task.id),
    onOpen: () => onOpen(task.id),
    onProperty: openProperty,
    onDelete: () => {
      deleteRequest.current = crypto.randomUUID();
      setConfirmDelete(true);
    },
  };
  const row = (
    <li
      className={`task-row ${task.completed ? "is-completed" : ""} ${selected.has(task.id) ? "is-selected" : ""} ${overId === task.id ? "drop-before" : ""}`}
      onContextMenu={(event) => {
        setContextPoint({ x: event.clientX, y: event.clientY });
        origin.current = "context";
      }}
      onDragOver={(event) => {
        if (draggedId && draggedId !== task.id) {
          event.preventDefault();
          setOverId(task.id);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (draggedId && draggedId !== task.id) onReorder(draggedId, task);
        setDraggedId("");
        setOverId("");
      }}
    >
      <button
        className="drag-handle"
        aria-label={`Drag ${task.title}`}
        draggable
        onDragStart={(event) => {
          setDraggedId(task.id);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", task.id);
        }}
        onDragEnd={() => {
          setDraggedId("");
          setOverId("");
        }}
      >
        <GripVertical size={15} />
      </button>
      <input
        className="task-select"
        type="checkbox"
        aria-label={`Select ${task.title}`}
        checked={selected.has(task.id)}
        onChange={() => onSelect(task.id)}
      />
      <button
        className={`complete-button priority-${task.priority}`}
        aria-label={`${task.completed ? "Reopen" : "Complete"} ${task.title}`}
        disabled={busyIds.has(task.id)}
        onClick={() => onComplete(task)}
      >
        {task.completed ? <Check size={12} /> : <Circle size={18} />}
      </button>
      <button className="task-open" onClick={() => onOpen(task.id)}>
        <span className="task-title">{task.title}</span>
        {task.descriptionPreview && (
          <span className="task-description">{task.descriptionPreview}</span>
        )}
        <span className="task-meta">
          {due && (
            <span
              className={due < today && !task.completed ? "overdue" : ""}
            >
              <CalendarDays size={12} />
              {dateLabel(due, today)}
              {task.dueDatetime &&
                ` ${new Date(task.dueDatetime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: task.dueTimezone || catalog.timeZone || undefined })}`}
            </span>
          )}
          {task.recurrence && (
            <span title={task.recurrence}>
              <Repeat2 size={12} />
              {repeatLabel(task.recurrence)}
            </span>
          )}
          {task.deadline && (
            <span className="deadline">
              <Flag size={12} />
              {dateLabel(task.deadline, today)}
            </span>
          )}
          {task.childCount > 0 && (
            <span>
              <ChevronRight size={12} />
              {task.completedChildCount}/{task.childCount}
            </span>
          )}
          {task.durationMinutes > 0 && (
            <span>
              <Timer size={12} />
              {task.durationMinutes}m
            </span>
          )}
          {task.labelIds.map((id) => {
            const label = catalog.labels.find((item) => item.id === id);
            return label ? (
              <span key={id}>
                <Tag size={11} style={{ color: label.color || undefined }} />
                {label.title}
              </span>
            ) : null;
          })}
        </span>
      </button>
      <span className="task-context">
        {parentTitle && (
          <span title={`Parent: ${parentTitle}`}>
            {parentTitle}
            <ChevronRight size={11} />
          </span>
        )}
        <span>
          {project?.title || "Inbox"}
          <span
            className="project-dot"
            style={{ background: project?.color || "#9a9a92" }}
          />
        </span>
      </span>
      {menuActions && (
        <Menu.Root
          onOpenChange={(open) => {
            if (open) origin.current = "more";
          }}
        >
          <Menu.Trigger
            ref={more}
            className={`icon-button task-more-button${chooser ? " is-active" : ""}`}
            aria-label={`More actions for ${task.title}`}
          >
            <MoreHorizontal size={17} />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner
              align="end"
              sideOffset={5}
              className="task-menu-positioner"
            >
              <Menu.Popup
                className="task-menu-popup"
                aria-label={`Actions for ${task.title}`}
              >
                <TaskMenuItems {...menuProps} actions={menuActions} />
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      )}
      <span
        ref={contextAnchor}
        className="task-context-anchor"
        style={{ left: contextPoint.x, top: contextPoint.y }}
      />
      {chooser && menuActions && (
        <TaskMenuChooser
          task={task}
          catalog={catalog}
          property={chooser.property}
          anchor={chooser.anchor}
          actions={menuActions}
          busy={busyIds.has(task.id)}
          onClose={() => setChooser(undefined)}
        />
      )}
      {confirmDelete && (
        <Dialog
          title="Delete task"
          onClose={() => setConfirmDelete(false)}
          className="catalog-dialog"
        >
          <p className="task-delete-copy">
            Delete <strong>{task.title}</strong> and its subtasks?
          </p>
          {deleteError && (
            <p role="alert" className="error-message">
              {deleteError}
            </p>
          )}
          <footer className="dialog-footer">
            <span className="spacer" />
            <button
              type="button"
              className="secondary-button"
              onClick={() => setConfirmDelete(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="danger-button"
              disabled={deleting}
              onClick={() => void remove()}
            >
              Delete task
            </button>
          </footer>
        </Dialog>
      )}
    </li>
  );
  return (
    <ContextMenu.Root disabled={!menuActions}>
      <ContextMenu.Trigger render={row} />
      {menuActions && (
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="task-menu-positioner">
            <ContextMenu.Popup
              className="task-menu-popup"
              aria-label={`Actions for ${task.title}`}
            >
              <TaskMenuItems {...menuProps} actions={menuActions} />
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      )}
    </ContextMenu.Root>
  );
}
