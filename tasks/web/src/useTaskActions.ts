import { useRef, useState } from "react";
import { RpcStatusError } from "@ziyixi/proto/http-client";
import {
  api,
  describeError,
  TASK_EDIT_FIELDS,
  type Task,
  type TaskDraft,
} from "./api";
import { isPlanning, type Route } from "./routes";
import { scheduledDate, scheduledTime } from "./task-schedule";
import { clearTaskStartAhead, taskScheduleFromText } from "./task-date-actions";
import { todayDate } from "./dates";
import { settleCompletedTask } from "./task-completion-focus";
import type { useTaskView } from "./useTaskView";

export function useTaskActions(
  route: Route,
  orderBy: string,
  list: ReturnType<typeof useTaskView>,
  today = todayDate(),
) {
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [mutationRevision, setMutationRevision] = useState(0);
  const completionRequests = useRef(
    new Map<string, { requestId: string; etag: string }>(),
  );
  const duplicateRequests = useRef(
    new Map<string, { requestId: string; etag: string }>(),
  );
  function taskChanged() {
    setMutationRevision((revision) => revision + 1);
  }
  async function saveTask(
    draft: TaskDraft,
    original?: Task,
    requestId: string = crypto.randomUUID(),
  ) {
    if (
      original &&
      Object.entries(draft).every(([field, value]) => {
        const current = original[field as keyof TaskDraft];
        return Array.isArray(value)
          ? Array.isArray(current) &&
              value.length === current.length &&
              value.every((id, index) => id === current[index])
          : value === current;
      })
    ) {
      setNotice("Task saved");
      return original;
    }
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
    if (!isPlanning(route.page) && route.page !== "catalog") await list.read();
    setNotice(original ? "Task saved" : "Task added");
    return task;
  }
  async function deleteTask(
    task: Task,
    requestId: string = crypto.randomUUID(),
  ) {
    await api.deleteTask({
      name: task.name,
      etag: task.etag,
      requestId,
    });
    taskChanged();
    list.remove(task.id);
    setNotice("Task deleted");
  }
  async function writeCompletion(task: Task, reopen = false) {
    const key = `${reopen ? "reopen" : "complete"}:${task.id}`;
    let completion = completionRequests.current.get(key);
    if (!completion) {
      completion = { requestId: crypto.randomUUID(), etag: task.etag };
      completionRequests.current.set(key, completion);
    }
    try {
      const result = await (reopen ? api.reopenTask : api.completeTask)({
        name: task.name,
        etag: completion.etag,
        requestId: completion.requestId,
      });
      completionRequests.current.delete(key);
      return { result, completion };
    } catch (error) {
      if (
        error instanceof RpcStatusError &&
        [400, 409].includes(error.status.httpStatus)
      )
        completionRequests.current.delete(key);
      throw error;
    }
  }
  async function complete(task: Task): Promise<string | undefined> {
    setBusyIds((current) => new Set([...current, task.id]));
    setNotice("");
    try {
      const { result, completion } = await writeCompletion(
        task,
        task.completed,
      );
      taskChanged();
      if (result.completed === (route.page === "completed"))
        list.replace(result);
      else list.remove(task.id);
      const confirmedMessage = task.completed
        ? "Task reopened"
        : result.recurrence
          ? "Occurrence completed · next date scheduled"
          : "Task completed";
      let warning = task.completed
        ? undefined
        : await settleCompletedTask(
            task,
            completion.requestId,
            completion.etag,
            today,
          );
      try {
        if (!isPlanning(route.page) && route.page !== "catalog")
          await list.read();
      } catch {
        warning = `${warning || confirmedMessage}. The task list could not refresh. Refresh the view.`;
      }
      setNotice(warning || confirmedMessage);
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
  async function patchTask(
    task: Task,
    values: Partial<TaskDraft>,
    fields: string[],
  ) {
    setBusyIds((current) => new Set([...current, task.id]));
    setNotice("");
    try {
      const result = await api.updateTask({
        requestId: crypto.randomUUID(),
        etag: task.etag,
        task: { name: task.name, ...values },
        updateMask: { paths: fields },
      });
      taskChanged();
      list.replace(result);
      await list.read();
      setNotice("Task updated");
    } catch (reason) {
      setNotice(describeError(reason));
      throw reason;
    } finally {
      setBusyIds(
        (current) => new Set([...current].filter((id) => id !== task.id)),
      );
    }
  }
  function setPriority(task: Task, priority: number) {
    return patchTask(task, { priority }, ["priority"]);
  }
  async function scheduleTask(task: Task, date: string, timeZone: string) {
    const zone = task.dueTimezone || timeZone;
    const schedule = await scheduledDate(
      date,
      scheduledTime(task.dueDatetime, zone),
      zone,
    );
    return patchTask(
      task,
      { ...schedule, ...(!date ? { recurrence: "" } : {}) },
      [
        "due_date",
        "due_datetime",
        "due_timezone",
        ...(!date ? ["recurrence"] : []),
      ],
    );
  }
  async function parseTaskSchedule(task: Task, text: string, timeZone: string) {
    const result = await taskScheduleFromText(task, text, timeZone);
    await patchTask(task, result.values, [
      "due_date",
      "due_datetime",
      "due_timezone",
      "recurrence",
    ]);
    if (result.ignoredClock)
      setNotice(
        "Date saved. Set a time on a Step or Standalone action in task details.",
      );
  }
  async function setDeadline(task: Task, deadline: string) {
    await patchTask(task, { deadline }, ["deadline"]);
    if (deadline || task.completed) return;
    try {
      await clearTaskStartAhead(task.id);
    } catch {
      setNotice(
        "Deadline saved. Start-ahead could not be cleared. Reopen the task to check it.",
      );
    }
  }
  function moveTask(task: Task, projectId: string, sectionId: string) {
    return patchTask(
      task,
      {
        projectId,
        sectionId,
        parentId: task.projectId === projectId ? task.parentId : "",
      },
      ["project_id", "section_id", "parent_id"],
    );
  }
  async function duplicateTask(task: Task) {
    setBusyIds((current) => new Set([...current, task.id]));
    setNotice("");
    try {
      let request = duplicateRequests.current.get(task.id);
      if (!request) {
        request = { requestId: crypto.randomUUID(), etag: task.etag };
        duplicateRequests.current.set(task.id, request);
      }
      await api.duplicateTask({
        name: task.name,
        etag: request.etag,
        requestId: request.requestId,
      });
      duplicateRequests.current.delete(task.id);
      taskChanged();
      await list.read();
      setNotice("Task duplicated");
    } catch (reason) {
      if (
        reason instanceof RpcStatusError &&
        [400, 409].includes(reason.status.httpStatus)
      )
        duplicateRequests.current.delete(task.id);
      setNotice(describeError(reason));
    } finally {
      setBusyIds(
        (current) => new Set([...current].filter((id) => id !== task.id)),
      );
    }
  }
  async function copyTaskLink(task: Task) {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/?task=${encodeURIComponent(task.id)}`,
      );
      setNotice("Task link copied");
    } catch {
      setNotice("Could not copy the link. Open the task and copy its address.");
    }
  }
  async function reorder(
    id: string,
    before: Task,
    peers: readonly Task[] = list.tasks,
  ) {
    if (orderBy !== "sort_order") {
      setNotice("Choose Custom order before dragging tasks.");
      return;
    }
    const task = peers.find((item) => item.id === id);
    if (
      !task ||
      task.parentId !== before.parentId ||
      task.projectId !== before.projectId ||
      task.sectionId !== before.sectionId
    ) {
      setNotice("Reorder tasks within the same project, section and parent.");
      return;
    }
    const siblings = peers.filter(
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
    const ids = [...selected];
    setBusyIds(new Set(ids));
    setNotice("");
    let focusWarning = "";
    try {
      const targets = await Promise.all(
        ids.map(
          (id) =>
            list.tasks.find((task) => task.id === id) ??
            api.getTask({ name: `tasks/${id}` }),
        ),
      );
      for (const task of targets) {
        if (action === "complete") {
          const { completion } = await writeCompletion(task);
          const warning = await settleCompletedTask(
            task,
            completion.requestId,
            completion.etag,
            today,
          );
          if (warning) focusWarning = warning;
        } else
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
        focusWarning ||
          (action === "complete"
            ? "Selected tasks completed"
            : "Selected tasks moved"),
      );
    } catch (reason) {
      setNotice(describeError(reason));
    } finally {
      setBusyIds(new Set());
      taskChanged();
      try {
        await list.read();
      } catch {
        setNotice((current) =>
          `${current} The task list could not refresh. Refresh the view.`.trim(),
        );
      }
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
    setPriority,
    scheduleTask,
    parseTaskSchedule,
    setDeadline,
    moveTask,
    duplicateTask,
    copyTaskLink,
  };
}
