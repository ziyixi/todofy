import { useRef, useState, type ReactNode } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import {
  Check,
  ChevronRight,
  Circle,
  GripVertical,
  MoreHorizontal,
} from "lucide-react";
import { type Catalog, type Task, describeError } from "../api";
import { TaskMetadata } from "./TaskMetadata";
import { TaskRowDropZones, useTaskDrag } from "./TaskDrag";
import { Dialog } from "./Dialog";
import {
  TaskMenuChooser,
  TaskMenuItems,
  type TaskMenuActions,
  type TaskMenuProperty,
} from "./TaskMenu";

export interface TaskRowProps {
  task: Task;
  catalog: Catalog;
  today: string;
  parentTitle?: string;
  busyIds: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onComplete: (task: Task) => void;
  menuActions?: TaskMenuActions;
  expanded?: boolean;
  onToggleChildren?: () => void;
  childListId?: string;
  childContent?: ReactNode;
  peers: readonly Task[];
  ancestors?: readonly string[];
}

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
  menuActions,
  expanded,
  onToggleChildren,
  childListId,
  childContent,
  peers,
  ancestors,
}: TaskRowProps) {
  const drag = useTaskDrag(task, busyIds.has(task.id));
  const project = catalog.projects.find((item) => item.id === task.projectId);
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
    onSelect: () => onSelect(task.id),
    selected: selected.has(task.id),
    onDelete: () => {
      deleteRequest.current = crypto.randomUUID();
      setConfirmDelete(true);
    },
  };
  const row = (
    <div
      ref={drag.ref}
      data-task-id={task.id}
      className={`task-row ${task.completed ? "is-completed" : ""} ${selected.has(task.id) ? "is-selected" : ""} ${drag.isDragSource ? "is-dragging" : ""}`}
      onContextMenu={(event) => {
        setContextPoint({ x: event.clientX, y: event.clientY });
        origin.current = "context";
      }}
    >
      <TaskRowDropZones
        task={task}
        peers={peers}
        ancestors={ancestors}
        busy={busyIds.has(task.id)}
      />
      {onToggleChildren && (task.childCount > 0 || expanded) ? (
        <button
          className="task-expand"
          aria-label={`${expanded ? "Collapse" : "Expand"} subtasks for ${task.title}`}
          aria-expanded={expanded}
          aria-controls={expanded ? childListId : undefined}
          onClick={onToggleChildren}
        >
          <ChevronRight size={15} />
        </button>
      ) : (
        <span className="task-expand-space" aria-hidden />
      )}
      <button
        ref={drag.handleRef}
        className="drag-handle"
        aria-label={`Drag ${task.title}`}
        disabled={busyIds.has(task.id)}
      >
        <GripVertical size={15} />
      </button>
      {selected.size > 0 ? (
        <span className="task-selection-slot">
          <input
            className="task-select"
            type="checkbox"
            aria-label={`Select ${task.title}`}
            checked={selected.has(task.id)}
            onChange={() => onSelect(task.id)}
          />
        </span>
      ) : (
        <button
          className={`complete-button priority-${task.priority}`}
          aria-label={`${task.completed ? "Reopen" : "Complete"} ${task.title}`}
          disabled={busyIds.has(task.id)}
          onClick={() => onComplete(task)}
        >
          {task.completed ? (
            <Check size={12} />
          ) : (
            <>
              <Circle size={18} />
              <Check size={11} className="complete-hover-check" aria-hidden />
            </>
          )}
        </button>
      )}
      <button
        className="task-open"
        onClick={(event) => {
          if (selected.size || event.metaKey || event.ctrlKey || event.shiftKey)
            onSelect(task.id);
          else onOpen(task.id);
        }}
      >
        <span className="task-title">{task.title}</span>
        {task.descriptionPreview && (
          <span className="task-description">{task.descriptionPreview}</span>
        )}
        <TaskMetadata task={task} catalog={catalog} today={today} />
      </button>
      <span className="task-context">
        {parentTitle && (
          <span title={`Parent: ${parentTitle}`}>
            <span className="task-context-name">{parentTitle}</span>
            <ChevronRight size={11} />
          </span>
        )}
        <span title={project?.title || "Inbox"}>
          <span className="task-context-name">{project?.title || "Inbox"}</span>
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
    </div>
  );
  return (
    <li className="task-branch">
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
      {childContent}
    </li>
  );
}
