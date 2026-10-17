import { useEffect, useState, type FormEvent } from "react";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import type { Catalog, Task, TaskDraft } from "../api";
import { api, describeError } from "../api";
import { Dialog } from "./Dialog";
import { TaskFields } from "./TaskFields";

export function TaskDialog({
  task,
  catalog,
  defaults,
  onClose,
  onSave,
  onDelete,
  onOpen,
  onComplete,
  onChildAdded,
}: {
  task?: Task;
  catalog: Catalog;
  defaults?: Partial<TaskDraft>;
  onClose: () => void;
  onSave: (draft: TaskDraft, original?: Task, requestId?: string) => Promise<void>;
  onDelete: (task: Task) => Promise<void>;
  onOpen: (id: string) => void;
  onComplete: (task: Task) => Promise<boolean>;
  onChildAdded: () => void;
}) {
  const [draft, setDraft] = useState<TaskDraft>(() => ({
    title: task?.title ?? "",
    description: task?.description ?? "",
    projectId: task?.projectId ?? "",
    sectionId: task?.sectionId ?? "",
    parentId: task?.parentId ?? "",
    labelIds: task?.labelIds ?? [],
    priority: task?.priority ?? 4,
    dueDate: task?.dueDate ?? "",
    dueDatetime: task?.dueDatetime ?? "",
    dueTimezone: task?.dueTimezone || "",
    deadline: task?.deadline ?? "",
    durationMinutes: task?.durationMinutes ?? 0,
    recurrence: task?.recurrence ?? "",
    ...defaults,
  }));
  const [busy, setBusy] = useState(false);
  const [saveRequestId] = useState(() => crypto.randomUUID());
  const [childRequestId, setChildRequestId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState("");
  const [children, setChildren] = useState<Task[]>([]);
  const [childTitle, setChildTitle] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [preview, setPreview] = useState("");
  const [dateText, setDateText] = useState("");
  const [childPage, setChildPage] = useState("");
  useEffect(() => {
    if (!task) return;
    let current = true;
    void api
      .listTasks({ parentId: task.id, pageSize: 100, includeCompleted: true })
      .then((result) => {
        if (current) {
          setChildren(result.tasks);
          setChildPage(result.nextPageToken);
        }
      })
      .catch((reason: unknown) => {
        if (current) setError(describeError(reason));
      });
    return () => {
      current = false;
    };
  }, [task]);
  const patch = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.title.trim()) return;
    setBusy(true);
    setError("");
    try {
      await onSave(
        {
          ...draft,
          title: draft.title.trim(),
          dueTimezone: draft.dueDatetime
            ? draft.dueTimezone || catalog.timeZone
            : "",
        },
        task,
        saveRequestId,
      );
      onClose();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  async function addChild() {
    if (!task || !childTitle.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.createTask({
        requestId: childRequestId,
        taskId: childRequestId,
        task: {
          title: childTitle.trim(),
          parentId: task.id,
          projectId: task.projectId,
          sectionId: task.sectionId,
          priority: 4,
        },
      });
      setChildren((current) => [...current, result]);
      onChildAdded();
      setChildTitle("");
      setChildRequestId(crypto.randomUUID());
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  async function previewDate() {
    if (!dateText.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.previewDate({
        text: dateText,
        timeZone: catalog.timeZone,
      });
      setDraft((current) => ({
        ...current,
        dueDate: result.dueDate,
        dueDatetime: result.dueDatetime,
        dueTimezone: result.dueTimezone,
        recurrence: result.recurrence,
      }));
      setPreview(`Next: ${result.dueDate}`);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  async function moreChildren() {
    if (!task || !childPage) return;
    setBusy(true);
    try {
      const result = await api.listTasks({
        parentId: task.id,
        pageSize: 100,
        pageToken: childPage,
        includeCompleted: true,
      });
      setChildren((current) => [...current, ...result.tasks]);
      setChildPage(result.nextPageToken);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  async function setSchedule(date: string, time: string) {
    if (!date || !time) {
      setDraft((current) => ({ ...current, dueDate: date, dueDatetime: "", dueTimezone: "" }));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api.previewDate({
        text: `${date} at ${time}`,
        timeZone: draft.dueTimezone || catalog.timeZone,
      });
      setDraft((current) => ({
        ...current,
        dueDate: result.dueDate,
        dueDatetime: result.dueDatetime,
        dueTimezone: result.dueTimezone,
      }));
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setBusy(false);
    }
  }
  function setDate(value: string) {
    const time = draft.dueDatetime
      ? new Date(draft.dueDatetime).toLocaleTimeString("sv-SE", {
          hour: "2-digit", minute: "2-digit", timeZone: draft.dueTimezone || catalog.timeZone,
        })
      : "";
    return setSchedule(value, time);
  }
  function setTime(value: string) {
    return setSchedule(draft.dueDate, value);
  }
  async function finish() {
    if (!task) return;
    setBusy(true);
    try {
      if (await onComplete(task)) onClose();
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!task) return;
    setBusy(true);
    setError("");
    try {
      await onDelete(task);
      onClose();
    } catch (reason) {
      setError(describeError(reason));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={task ? "Task details" : "Add task"}
      onClose={onClose}
      className={task ? "task-dialog" : "task-dialog quick-add-dialog"}
    >
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      <form
        onSubmit={submit}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            (event.metaKey || event.ctrlKey) &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            event.currentTarget.requestSubmit();
          }
        }}
      >
        <TaskFields
          task={task}
          draft={draft}
          catalog={catalog}
          busy={busy}
          dateText={dateText}
          preview={preview}
          patch={patch}
          setDraft={setDraft}
          setDateText={setDateText}
          setPreview={setPreview}
          previewDate={previewDate}
          setTime={setTime}
          setDate={setDate}
          finish={finish}
          onOpen={onOpen}
        >
          {task && (
            <section className="subtasks">
              <h3>
                Subtasks{" "}
                <span>
                  {children.filter((child) => child.completed).length}/
                  {children.length}
                  {childPage ? "+" : ""}
                </span>
              </h3>
              {children.map((child) => (
                <button
                  type="button"
                  className={`subtask-link ${child.completed ? "is-completed" : ""}`}
                  key={child.id}
                  onClick={() => onOpen(child.id)}
                >
                  {child.title}
                  <ChevronRight size={14} />
                </button>
              ))}
              {childPage && (
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => void moreChildren()}
                >
                  Load more subtasks
                </button>
              )}
              <div className="inline-add">
                <Plus size={16} />
                <input
                  aria-label="New subtask"
                  placeholder="Add subtask"
                  value={childTitle}
                  onChange={(event) => setChildTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      !event.nativeEvent.isComposing
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                      void addChild();
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => void addChild()}
                  className="text-button"
                  disabled={busy || !childTitle.trim()}
                >
                  Add
                </button>
              </div>
            </section>
          )}
        </TaskFields>
        <footer className="dialog-footer">
          {task && (
            <button
              type="button"
              className="text-button danger"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 size={15} />
              Delete
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={busy || !draft.title.trim()}
          >
            {busy ? "Saving…" : task ? "Save changes" : "Add task"}
          </button>
        </footer>
      </form>
      {confirmDelete && (
        <div className="delete-confirm" role="alert">
          <p>Delete this task and its subtasks?</p>
          <button
            className="secondary-button"
            onClick={() => setConfirmDelete(false)}
          >
            Keep task
          </button>
          <button
            className="danger-button"
            disabled={busy}
            onClick={() => void remove()}
          >
            Delete task
          </button>
        </div>
      )}
    </Dialog>
  );
}
