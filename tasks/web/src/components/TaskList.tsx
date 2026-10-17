import { useMemo, useState } from "react";
import {
  CalendarDays,
  Check,
  ChevronRight,
  Circle,
  Flag,
  GripVertical,
  Repeat2,
  Tag,
  Timer,
} from "lucide-react";
import type { Catalog, Task } from "../api";
import { planningChips } from "../planning-presentation";
import { dateLabel, todayDate } from "../dates";

export function TaskList({
  tasks,
  catalog,
  managedRoles,
  busyIds,
  selected,
  onSelect,
  onOpen,
  onComplete,
  onReorder,
  groupBy = "none",
}: {
  tasks: Task[];
  catalog: Catalog;
  managedRoles: ReadonlyMap<string, string>;
  busyIds: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onComplete: (task: Task) => void;
  onReorder: (id: string, before: Task) => void;
  groupBy?: "none" | "date" | "section";
}) {
  const [draggedId, setDraggedId] = useState("");
  const [overId, setOverId] = useState("");
  const taskIndex = useMemo(
    () => new Map(tasks.map((task) => [task.id, task])),
    [tasks],
  );
  const groups = useMemo(() => {
    const result = new Map<string, Task[]>();
    for (const task of tasks) {
      const key =
        groupBy === "date"
          ? task.dueDate || task.dueDatetime.slice(0, 10) || "No date"
          : groupBy === "section"
            ? task.sectionId
            : "";
      result.set(key, [...(result.get(key) ?? []), task]);
    }
    return [...result];
  }, [tasks, groupBy]);
  function heading(key: string): string {
    if (groupBy === "section")
      return (
        catalog.sections.find((section) => section.id === key)?.title || "Tasks"
      );
    if (key === "No date") return key;
    const date = new Date(`${key}T12:00:00`);
    return key < todayDate()
      ? `Overdue · ${dateLabel(key)}`
      : `${dateLabel(key)} · ${date.toLocaleDateString(undefined, { weekday: "long" })}`;
  }
  return (
    <div className="task-groups">
      {groups.map(([group, items]) => (
        <section key={group}>
          {groupBy !== "none" && (
            <h2 className="task-group-heading">
              {heading(group)}
              <span>{items.length}</span>
            </h2>
          )}
          <ul className="task-list">
            {items.map((task) => {
              const project = catalog.projects.find(
                (item) => item.id === task.projectId,
              );
              const parentTitle =
                task.parentTitle || taskIndex.get(task.parentId)?.title;
              const due = task.dueDate || task.dueDatetime.slice(0, 10);
              return (
                <li
                  key={task.id}
                  className={`task-row ${task.completed ? "is-completed" : ""} ${selected.has(task.id) ? "is-selected" : ""} ${overId === task.id ? "drop-before" : ""}`}
                  onDragOver={(event) => {
                    if (draggedId && draggedId !== task.id) {
                      event.preventDefault();
                      setOverId(task.id);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (draggedId && draggedId !== task.id)
                      onReorder(draggedId, task);
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
                    {task.completed ? (
                      <Check size={12} />
                    ) : (
                      <Circle size={18} />
                    )}
                  </button>
                  <button className="task-open" onClick={() => onOpen(task.id)}>
                    <span className="task-title">{task.title}</span>
                    {task.descriptionPreview && (
                      <span className="task-description">
                        {task.descriptionPreview}
                      </span>
                    )}
                    <span className="task-meta">
                      {due && (
                        <span
                          className={
                            due < todayDate() && !task.completed
                              ? "overdue"
                              : ""
                          }
                        >
                          <CalendarDays size={12} />
                          {dateLabel(due)}
                          {task.dueDatetime &&
                            ` ${new Date(task.dueDatetime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}
                        </span>
                      )}
                      {task.recurrence && (
                        <span title={task.recurrence}>
                          <Repeat2 size={12} />
                          {task.recurrence}
                        </span>
                      )}
                      {task.deadline && (
                        <span className="deadline">
                          <Flag size={12} />
                          {dateLabel(task.deadline)}
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
                      {planningChips(task.labelIds, managedRoles).map(
                        (title) => (
                          <span className="planning-chip" key={title}>
                            {title}
                          </span>
                        ),
                      )}
                      {task.labelIds
                        .filter((id) => !managedRoles.has(id))
                        .map((id) => {
                          const label = catalog.labels.find(
                            (item) => item.id === id,
                          );
                          return label ? (
                            <span key={id}>
                              <Tag size={11} />
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
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
