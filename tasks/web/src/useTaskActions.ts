import { useState } from "react";
import {
  api,
  describeError,
  TASK_EDIT_FIELDS,
  type Task,
  type TaskDraft,
} from "./api";
import { isPlanning, type Route } from "./routes";
import type { useTaskView } from "./useTaskView";

export function useTaskActions(
  route: Route,
  orderBy: string,
  list: ReturnType<typeof useTaskView>,
) {
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [mutationRevision, setMutationRevision] = useState(0);
  function taskChanged() {
    setMutationRevision((revision) => revision + 1);
  }
  async function saveTask(draft: TaskDraft, original?: Task, requestId: string = crypto.randomUUID()) {
    const task = original
      ? await api.updateTask({
          requestId,
          etag: original.etag,
          task: { ...draft, name: original.name, etag: original.etag },
          updateMask: { paths: TASK_EDIT_FIELDS },
        })
      : await api.createTask({ requestId, taskId: requestId, task: draft });
    taskChanged();
    if (original) list.replace(task);
    // Membership can change with date, labels or parent. Re-read this bounded view only.
    if (
      !isPlanning(route.page) &&
      !["catalog", "settings"].includes(route.page)
    )
      await list.read();
    setNotice(original ? "Task saved" : "Task added");
  }
  async function deleteTask(task: Task) {
    await api.deleteTask({
      name: task.name,
      etag: task.etag,
      requestId: crypto.randomUUID(),
    });
    taskChanged();
    list.remove(task.id);
    setNotice("Task deleted");
  }
  async function complete(task: Task): Promise<string | undefined> {
    setBusyIds((current) => new Set([...current, task.id]));
    setNotice("");
    try {
      const result = await (task.completed ? api.reopenTask : api.completeTask)(
        { name: task.name, etag: task.etag, requestId: crypto.randomUUID() },
      );
      taskChanged();
      if (result.completed === (route.page === "completed"))
        list.replace(result);
      else list.remove(task.id);
      if (
        !isPlanning(route.page) &&
        !["catalog", "settings"].includes(route.page)
      )
        await list.read();
      setNotice(
        task.completed
          ? "Task reopened"
          : result.recurrence
            ? "Occurrence completed · next date scheduled"
            : "Task completed",
      );
      return undefined;
    } catch (reason) {
      const message = describeError(reason);
      setNotice(message);
      return message;
    } finally {
      setBusyIds(
        (current) => new Set([...current].filter((id) => id !== task.id)),
      );
    }
  }
  async function reorder(id: string, before: Task) {
    if (orderBy !== "sort_order") {
      setNotice("Choose Custom order before dragging tasks.");
      return;
    }
    const task = list.tasks.find((item) => item.id === id);
    if (
      !task ||
      task.parentId !== before.parentId ||
      task.projectId !== before.projectId ||
      task.sectionId !== before.sectionId
    ) {
      setNotice("Reorder tasks within the same project, section and parent.");
      return;
    }
    const siblings = list.tasks.filter(
      (item) =>
        item.id !== id &&
        item.parentId === before.parentId &&
        item.sectionId === before.sectionId &&
        item.projectId === before.projectId,
    );
    const index = siblings.findIndex((item) => item.id === before.id);
    const previous = siblings[index - 1];
    const sortOrder = previous
      ? ((previous.sortOrder ?? 0) + (before.sortOrder ?? 0)) / 2
      : (before.sortOrder ?? 0) - 1;
    setBusyIds(new Set([id]));
    try {
      await api.updateTask({
        requestId: crypto.randomUUID(),
        etag: task.etag,
        task: { name: task.name, sortOrder },
        updateMask: { paths: ["sort_order"] },
      });
      await list.read();
    } catch (reason) {
      setNotice(describeError(reason));
    } finally {
      setBusyIds(new Set());
    }
  }
  async function batch(action: "complete" | "move", projectId = "") {
    const targets = list.tasks.filter((task) => selected.has(task.id));
    setBusyIds(new Set(targets.map((task) => task.id)));
    setNotice("");
    try {
      for (const task of targets) {
        if (action === "complete")
          await api.completeTask({
            name: task.name,
            etag: task.etag,
            requestId: crypto.randomUUID(),
          });
        else
          await api.updateTask({
            etag: task.etag,
            task: {
              name: task.name,
              etag: task.etag,
              projectId,
              sectionId: "",
              parentId: "",
            },
            updateMask: { paths: ["project_id", "section_id", "parent_id"] },
            requestId: crypto.randomUUID(),
          });
        setSelected(
          (current) => new Set([...current].filter((id) => id !== task.id)),
        );
      }
      setNotice(
        action === "complete"
          ? "Selected tasks completed"
          : "Selected tasks moved",
      );
    } catch (reason) {
      setNotice(describeError(reason));
    } finally {
      setBusyIds(new Set());
      await list.read();
    }
  }
  return {
    saveTask,
    deleteTask,
    complete,
    reorder,
    batch,
    busyIds,
    selected,
    setSelected,
    notice,
    setNotice,
    mutationRevision,
    taskChanged,
  };
}
