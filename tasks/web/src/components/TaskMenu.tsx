import { useState, type ReactNode } from "react";
import { Menu } from "@base-ui/react/menu";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  CalendarArrowUp,
  CalendarDays,
  CalendarRange,
  Check,
  Copy,
  ExternalLink,
  Flag,
  FolderInput,
  Link,
  Pencil,
  Sofa,
  Sun,
  Sunrise,
  Trash2,
} from "lucide-react";
import type { Catalog, Task } from "../api";
import { describeError } from "../api";
import { shiftDate, todayDate } from "../dates";
import type { useTaskActions } from "../useTaskActions";
import { ProjectPicker } from "./ProjectPicker";
import { SchedulePicker } from "./SchedulePicker";
import "./task-menus.css";

export type TaskMenuProperty = "date" | "deadline" | "move";
export type TaskMenuActions = Pick<
  ReturnType<typeof useTaskActions>,
  | "complete"
  | "setPriority"
  | "scheduleTask"
  | "parseTaskSchedule"
  | "setDeadline"
  | "moveTask"
  | "duplicateTask"
  | "copyTaskLink"
  | "deleteTask"
  | "setNotice"
>;

function TaskMenuIcon({
  label,
  children,
  className = "task-menu-icon",
  disabled,
  onClick,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  disabled: boolean;
  onClick: Menu.Item.Props["onClick"];
}) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger
        delay={250}
        render={
          <Menu.Item
            className={className}
            disabled={disabled}
            aria-label={label}
            label={label}
            onClick={onClick}
          />
        }
      >
        {children}
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Positioner
          className="task-shortcut-tooltip-positioner"
          side="top"
          sideOffset={6}
        >
          <Tooltip.Popup role="tooltip" className="task-shortcut-tooltip">
            {label}
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function TaskMenuItems({
  task,
  catalog,
  actions,
  busy,
  onOpen,
  onProperty,
  onDelete,
}: {
  task: Task;
  catalog: Catalog;
  actions: TaskMenuActions;
  busy: boolean;
  onOpen: () => void;
  onProperty: (property: TaskMenuProperty) => void;
  onDelete: () => void;
}) {
  const today = todayDate(new Date(), catalog.timeZone || undefined);
  const weekday = new Date(`${today}T12:00:00`).getDay();
  const nextWeek = shiftDate(today, (8 - weekday) % 7 || 7);
  function run(operation: Promise<unknown>) {
    void operation.catch((reason) => actions.setNotice(describeError(reason)));
  }
  return (
    <>
      <div className="task-menu-shortcuts" aria-label="Schedule shortcuts">
        <TaskMenuIcon
          disabled={busy}
          label="Today"
          onClick={() =>
            run(actions.scheduleTask(task, today, catalog.timeZone))
          }
        >
          <Sun size={17} color="#058527" />
        </TaskMenuIcon>
        <TaskMenuIcon
          disabled={busy}
          label="Tomorrow"
          onClick={() =>
            run(
              actions.scheduleTask(task, shiftDate(today, 1), catalog.timeZone),
            )
          }
        >
          <Sunrise size={17} color="#ad6200" />
        </TaskMenuIcon>
        <TaskMenuIcon
          disabled={busy}
          label="Next week"
          onClick={() =>
            run(actions.scheduleTask(task, nextWeek, catalog.timeZone))
          }
        >
          <CalendarArrowUp size={17} color="#a146ba" />
        </TaskMenuIcon>
        <TaskMenuIcon
          disabled={busy}
          label="Next weekend"
          onClick={() =>
            run(
              actions.scheduleTask(
                task,
                shiftDate(today, (6 - weekday + 7) % 7 || 7),
                catalog.timeZone,
              ),
            )
          }
        >
          <Sofa size={17} color="#246fe0" />
        </TaskMenuIcon>
        <TaskMenuIcon
          disabled={busy}
          label="More dates"
          onClick={() => onProperty("date")}
        >
          <CalendarDays size={17} />
        </TaskMenuIcon>
      </div>
      <div className="task-menu-shortcuts" aria-label="Priority shortcuts">
        {["#d1453b", "#eb8909", "#246fe0", "#808080"].map((color, index) => (
          <TaskMenuIcon
            key={color}
            className={`task-menu-icon${task.priority === index + 1 ? " is-current" : ""}`}
            disabled={busy}
            label={`Priority ${index + 1}`}
            onClick={() => run(actions.setPriority(task, index + 1))}
          >
            <Flag size={16} color={color} fill={index < 3 ? color : "none"} />
          </TaskMenuIcon>
        ))}
      </div>
      <Menu.Separator className="task-menu-separator" />
      <Menu.Item className="task-menu-item" onClick={onOpen}>
        <Pencil size={15} />
        Edit
      </Menu.Item>
      <Menu.Item
        className="task-menu-item"
        onClick={() => {
          const project = catalog.projects.find(
            (item) => item.id === task.projectId,
          );
          window.location.hash =
            !task.projectId || project?.inbox
              ? "/inbox"
              : `/project/${encodeURIComponent(task.projectId)}`;
        }}
      >
        <ExternalLink size={15} />
        Go to project
      </Menu.Item>
      <Menu.Item
        className="task-menu-item"
        disabled={busy}
        onClick={() => onProperty("deadline")}
      >
        <CalendarRange size={15} />
        Deadline
      </Menu.Item>
      <Menu.Item
        className="task-menu-item"
        disabled={busy}
        onClick={() => void actions.complete(task)}
      >
        <Check size={15} />
        {task.completed ? "Reopen" : "Complete"}
      </Menu.Item>
      <Menu.Separator className="task-menu-separator" />
      <Menu.Item
        className="task-menu-item"
        disabled={busy}
        onClick={() => onProperty("move")}
      >
        <FolderInput size={15} />
        Move to
      </Menu.Item>
      <Menu.Item
        className="task-menu-item"
        disabled={busy}
        onClick={() => void actions.duplicateTask(task)}
      >
        <Copy size={15} />
        Duplicate
      </Menu.Item>
      <Menu.Item
        className="task-menu-item"
        onClick={() => void actions.copyTaskLink(task)}
      >
        <Link size={15} />
        Copy link to task
      </Menu.Item>
      <Menu.Separator className="task-menu-separator" />
      <Menu.Item
        className="task-menu-item danger"
        disabled={busy}
        onClick={onDelete}
      >
        <Trash2 size={15} />
        Delete
      </Menu.Item>
    </>
  );
}

export function TaskMenuChooser({
  task,
  catalog,
  property,
  anchor,
  actions,
  busy,
  onClose,
}: {
  task: Task;
  catalog: Catalog;
  property: TaskMenuProperty;
  anchor: HTMLElement;
  actions: TaskMenuActions;
  busy: boolean;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  if (property === "move")
    return (
      <ProjectPicker
        anchor={anchor}
        catalog={catalog}
        projectId={task.projectId}
        sectionId={task.sectionId}
        disabled={busy}
        open
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
        onChange={(projectId, sectionId) => {
          void actions
            .moveTask(task, projectId, sectionId)
            .then(onClose)
            .catch(() => {});
        }}
      />
    );
  const deadline = property === "deadline";
  return (
    <SchedulePicker
      anchor={anchor}
      label={deadline ? "Deadline" : "Date"}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      value={deadline ? task.deadline : task.dueDate}
      disabled={busy}
      timeZone={task.dueTimezone || catalog.timeZone}
      onChange={(date) =>
        deadline
          ? actions.setDeadline(task, date)
          : actions.scheduleTask(task, date, catalog.timeZone)
      }
      {...(!deadline
        ? {
            text,
            onTextChange: setText,
            onParse: async () => {
              await actions.parseTaskSchedule(task, text, catalog.timeZone);
              onClose();
            },
          }
        : {})}
    />
  );
}
