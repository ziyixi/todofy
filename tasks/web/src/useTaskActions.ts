import { useCallback, useRef, useState } from "react";
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
import { taskScheduleFromText } from "./task-date-actions";
import type { planningChanges } from "./task-planning";
import { todayDate } from "./dates";
import { taskDropOrder } from "./task-order";
import type { useTaskView } from "./useTaskView";
import type { TaskDropTarget, TaskRowDrop } from "./task-drag";

/** What a completion writes: the task, by name, under its etag. */
export type CompletedTask = Pick<Task, "id" | "name" | "etag">;

export function useTaskActions(
  route: Route,
  orderBy: string,
  list: ReturnType<typeof useTaskView>,
  today = todayDate(),
) {
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState("");
  // Every confirmed write, after which the sidebar's counts are read again.
  const [mutationRevision, setMutationRevision] = useState(0);
  // The writes Plan and Focus did not issue, after which they read again. They read their own writes back
  // themselves, so a completion from Plan is read once, not again for this revision.
  const [planRevision, setPlanRevision] = useState(0);
  // Read when a completion is confirmed, so the completion actions keep one identity as the page changes:
  // a new finishTask would make Plan read again when the owner switches between Plan and Focus.
  const page = useRef(route.page);
  page.current = route.page;
  const completionRequests = useRef(
    new Map<string, { requestId: string; etag: string }>(),
  );
  const duplicateRequests = useRef(
    new Map<string, { requestId: string; etag: string }>(),
  );
  const taskChanged = useCallback(() => {
    setMutationRevision((revision) => revision + 1);
    setPlanRevision((revision) => revision + 1);
  }, []);
  /** One write of the task: its content and the planning paths the dialog changed (`planning`). */
  async function saveTask(
    draft: TaskDraft,
    original?: Task,
    requestId: string = crypto.randomUUID(),
    planning?: ReturnType<typeof planningChanges>,
  ) {
    const planned = planning ?? { paths: [], values: {} };
    if (
      original &&
      !planned.paths.length &&
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
          task: {
            ...draft,
            ...planned.values,
            name: original.name,
            etag: original.etag,
          },
          updateMask: { paths: [...TASK_EDIT_FIELDS, ...planned.paths] },
        })
      : await api.createTask({
          requestId,
          taskId: requestId,
          task: { ...draft, ...planned.values },
        });
    taskChanged();
    if (original) list.replace(task);
    // Membership can change with date, labels or parent. Re-read this bounded view only.
    if (!isPlanning(route.page) && route.page !== "catalog")
      await list.refresh();
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
  /**
   * Completes or reopens the task. A completion from Plan or Focus brings its request ID and Focus day, whose
   * queue Tasks settles in the same write; the task list sends no day, which Tasks reads as its today.
   */
  const writeCompletion = useCallback(
    async (
      task: CompletedTask,
      reopen = false,
      requestId?: string,
      focusDay?: string,
    ) => {
      const action = reopen ? "reopen" : "complete";
      const key = `${requestId ? "queued" : action}:${task.id}`;
      let completion = completionRequests.current.get(key);
      if (!completion || (requestId && completion.requestId !== requestId)) {
        completion = {
          requestId: requestId || crypto.randomUUID(),
          etag: task.etag,
        };
        completionRequests.current.set(key, completion);
      }
      try {
        const write = {
          name: task.name,
          etag: completion.etag,
          requestId: completion.requestId,
        };
        const result = reopen
          ? await api.reopenTask(write)
          : await api.completeTask({ ...write, focusDay });
        // Planning views supply one identity per queued operation; retain only the latest baseline per task.
        if (!requestId) completionRequests.current.delete(key);
        return result;
      } catch (error) {
        if (
          error instanceof RpcStatusError &&
          [400, 409].includes(error.status.httpStatus)
        )
          completionRequests.current.delete(key);
        throw error;
      }
    },
    [],
  );
  /** `planned` is a completion from Plan or Focus, with its request ID and Focus day. */
  const applyCompletion = useCallback(
    async (
      task: CompletedTask,
      reopen: boolean,
      planned?: { requestId: string; focusDay?: string },
    ): Promise<string | undefined> => {
      setBusyIds((current) => new Set([...current, task.id]));
      setNotice("");
      try {
        const result = await writeCompletion(
          task,
          reopen,
          planned?.requestId,
          planned?.focusDay,
        );
        if (planned) setMutationRevision((revision) => revision + 1);
        else taskChanged();
        if (result.completed === (page.current === "completed"))
          list.replace(result);
        else list.remove(task.id);
        const confirmedMessage = reopen
          ? "Task reopened"
          : result.recurrence
            ? "Occurrence completed · next date scheduled"
            : "Task completed";
        let notice = confirmedMessage;
        try {
          if (!isPlanning(page.current) && page.current !== "catalog")
            await list.refresh();
        } catch {
          notice = `${confirmedMessage}. The task list could not refresh. Refresh the view.`;
        }
        setNotice(notice);
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
    },
    [list.replace, list.remove, list.refresh, taskChanged, writeCompletion],
  );
  function complete(task: Task) {
    return applyCompletion(task, task.completed);
  }
  const finishTask = useCallback(
    (task: CompletedTask, requestId: string, focusDay?: string) =>
      applyCompletion(task, false, { requestId, focusDay }),
    [applyCompletion],
  );
  async function patchTask(
    task: Task,
    values: Partial<TaskDraft> & { sortOrder?: number },
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
      await list.refresh();
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
  /** Clearing the deadline clears its start-ahead days in the same write. */
  function setDeadline(task: Task, deadline: string) {
    return patchTask(task, { deadline }, ["deadline"]);
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
  async function dropOnCategory(
    id: string,
    target: TaskDropTarget,
    timeZone: string,
  ) {
    try {
      const task = await api.getTask({ name: `tasks/${id}` });
      if (target.page === "today") {
        await scheduleTask(task, today, timeZone);
      } else if (target.page === "label") {
        if (task.labelIds.includes(target.id)) {
          setNotice("Label already applied");
          return;
        }
        await patchTask(task, { labelIds: [...task.labelIds, target.id] }, [
          "label_ids",
        ]);
      } else {
        await patchTask(
          task,
          {
            projectId: target.page === "project" ? target.id : "",
            sectionId: "",
            parentId: "",
          },
          ["project_id", "section_id", "parent_id"],
        );
      }
    } catch (reason) {
      setNotice(describeError(reason));
    }
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
      await list.refresh();
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
  async function dropInList(task: Task, target: TaskRowDrop) {
    if (task.id === target.task.id) return false;
    const inside = target.position === "inside";
    const parentId = inside ? target.task.id : target.task.parentId;
    const sameGroup =
      task.parentId === parentId &&
      task.projectId === target.task.projectId &&
      task.sectionId === target.task.sectionId;
    if (inside && sameGroup) return false;
    if (!inside && sameGroup && orderBy !== "sort_order") {
      setNotice("Choose Custom order before dragging tasks.");
      return false;
    }
    let sortOrder: number | undefined;
    if (inside) {
      // Insert first, including when this parent's children have never been expanded.
      const children = await api.listTasks({
        parentId: target.task.id,
        pageSize: 1,
        orderBy: "sort_order",
        includeCompleted: true,
      });
      sortOrder = (children.tasks[0]?.sortOrder ?? 0) - 1;
    } else {
      const siblings = target.peers
        .filter(
          (item) =>
            item.parentId === target.task.parentId &&
            item.sectionId === target.task.sectionId &&
            item.projectId === target.task.projectId,
        )
        .sort((left, right) => (left.sortOrder ?? 0) - (right.sortOrder ?? 0));
      sortOrder = taskDropOrder(
        siblings,
        task.id,
        target.task.id,
        target.position === "after",
      );
    }
    if (sortOrder === undefined || (sameGroup && sortOrder === task.sortOrder))
      return false;
    await patchTask(
      task,
      {
        parentId,
        projectId: target.task.projectId,
        sectionId: target.task.sectionId,
        sortOrder,
      },
      ["parent_id", "project_id", "section_id", "sort_order"],
    );
    return true;
  }
  async function detach(task: Task) {
    if (!task.parentId || task.kind === "step") return false;
    const sortOrder =
      Math.max(
        0,
        ...list.tasks
          .filter(
            (other) =>
              !other.parentId &&
              other.projectId === task.projectId &&
              other.sectionId === task.sectionId,
          )
          .map((other) => other.sortOrder ?? 0),
      ) + 1;
    await patchTask(task, { parentId: "", sortOrder }, [
      "parent_id",
      "sort_order",
    ]);
    setNotice("Task moved out of its parent");
    return true;
  }
  async function batch(action: "complete" | "move", projectId = "") {
    const ids = [...selected];
    setBusyIds(new Set(ids));
    setNotice("");
    try {
      // A subtask selected in an expanded branch is not one of the list's rows, so it is read once.
      const chosen = await Promise.all(
        ids.map(
          (id) =>
            list.tasks.find((task) => task.id === id) ??
            api.getTask({ name: `tasks/${id}` }),
        ),
      );
      const byId = new Map(
        [...list.tasks, ...chosen].map((task) => [task.id, task]),
      );
      // Completing or moving a task changes its descendants too, so a selected descendant is covered by its
      // topmost selected ancestor; writing it again would only fail on its now stale etag. An ancestor that is
      // not one of the list's rows, such as Today's undated middle parent, is read once per batch, before any
      // write.
      const ancestor = async (id: string) => {
        if (!id) return undefined;
        const known = byId.get(id);
        if (known) return known;
        const read = await api.getTask({ name: `tasks/${id}` });
        byId.set(id, read);
        return read;
      };
      const covered = new Map<string, string[]>();
      for (const task of chosen) {
        let root = task;
        let parent =
          chosen.length > 1 ? await ancestor(task.parentId) : undefined;
        for (let depth = 0; parent && depth < 32; depth++) {
          if (selected.has(parent.id)) root = parent;
          parent = await ancestor(parent.parentId);
        }
        covered.set(root.id, [...(covered.get(root.id) ?? []), task.id]);
      }
      const targets = chosen.filter((task) => covered.has(task.id));
      for (const task of targets) {
        if (action === "complete") await writeCompletion(task);
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
        const done = covered.get(task.id) ?? [task.id];
        setSelected(
          (current) => new Set([...current].filter((id) => !done.includes(id))),
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
      taskChanged();
      try {
        await list.refresh();
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
    finishTask,
    dropInList,
    detach,
    batch,
    busyIds,
    selected,
    setSelected,
    notice,
    setNotice,
    mutationRevision,
    planRevision,
    taskChanged,
    setPriority,
    scheduleTask,
    parseTaskSchedule,
    setDeadline,
    moveTask,
    dropOnCategory,
    duplicateTask,
    copyTaskLink,
  };
}
