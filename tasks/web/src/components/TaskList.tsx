import { useMemo, useState } from "react";
import type { Catalog, Task } from "../api";
import { dateLabel, todayDate } from "../dates";
import { TaskTreeRow } from "./TaskTreeRow";
import type { TaskMenuActions } from "./TaskMenu";

export function TaskList({
  tasks,
  catalog,
  busyIds,
  selected,
  onSelect,
  onOpen,
  onComplete,
  onReorder,
  groupBy = "none",
  menuActions,
  showCompleted = false,
  orderBy = "sort_order",
}: {
  tasks: Task[];
  catalog: Catalog;
  busyIds: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onComplete: (task: Task) => void;
  onReorder: (id: string, before: Task, peers?: readonly Task[]) => void;
  groupBy?: "none" | "date" | "section";
  menuActions?: TaskMenuActions;
  showCompleted?: boolean;
  orderBy?: string;
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
    const groups = [...result];
    if (groupBy === "date") {
      groups.sort(([left], [right]) => {
        if (left === right) return 0;
        if (left === "No date") return 1;
        if (right === "No date") return -1;
        return left.localeCompare(right);
      });
    }
    return groups;
  }, [tasks, groupBy]);
  const today = todayDate(new Date(), catalog.timeZone || undefined);
  const listedIds = useMemo(
    () => new Set(tasks.map((task) => task.id)),
    [tasks],
  );
  const row = {
    catalog,
    today,
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
  };
  function heading(key: string): string {
    if (groupBy === "section")
      return (
        catalog.sections.find((section) => section.id === key)?.title || "Tasks"
      );
    if (key === "No date") return key;
    const date = new Date(`${key}T12:00:00`);
    return key < today
      ? `Overdue · ${dateLabel(key, today)}`
      : `${dateLabel(key, today)} · ${date.toLocaleDateString(undefined, { weekday: "long" })}`;
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
            {items.map((task) => (
              <TaskTreeRow
                key={task.id}
                task={task}
                row={row}
                listedIds={listedIds}
                showCompleted={showCompleted}
                orderBy={orderBy}
                parentTitle={
                  task.parentTitle || taskIndex.get(task.parentId)?.title
                }
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
