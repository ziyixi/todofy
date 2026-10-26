import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { api, describeError, type Task } from "../api";
import { todayDate } from "../dates";
import { taskDropOrder } from "../task-order";
import "./task-children.css";
import { TaskDragProvider } from "./TaskDrag";
import { TaskChildRow } from "./TaskChildRow";
import { useDeleteConfirmation } from "../useDeleteConfirmation";

export function TaskChildren({
  task,
  timeZone,
  busy,
  onBusy,
  onError,
  onChanged,
  onOpen,
  onDelete,
  onComplete,
}: {
  task: Task;
  timeZone: string;
  busy: boolean;
  onBusy: (value: boolean) => void;
  onError: (message: string) => void;
  onChanged: () => void;
  onOpen: (id: string) => void;
  onDelete: (task: Task) => Promise<void>;
  onComplete: (task: Task) => Promise<string | undefined>;
}) {
  const today = todayDate(new Date(), timeZone || undefined);
  const [children, setChildren] = useState<Task[]>([]);
  // GetTask counts the children, so a task without any reads nothing here.
  const [loading, setLoading] = useState(task.childCount > 0);
  const [page, setPage] = useState("");
  const [adding, setAdding] = useState<"task" | "step" | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const addTrigger = useRef<HTMLButtonElement | null>(null);
  const [title, setTitle] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [deleting, setDeleting] = useState("");
  const deletion = useDeleteConfirmation(Boolean(deleting), busy, () =>
    setDeleting(""),
  );
  // A successful add renews requestId; return to the re-enabled composer for the next item.
  useEffect(() => {
    if (adding) input.current?.focus();
  }, [adding, requestId]);
  // Once per task: a child added here joins the list, and a later count (after a save) reads nothing more.
  useEffect(() => {
    if (!task.childCount) return;
    let active = true;
    setLoading(true);
    void api
      .listTasks({ parentId: task.id, pageSize: 100, includeCompleted: true })
      .then((value) => {
        if (active) {
          setChildren(value.tasks);
          setPage(value.nextPageToken);
        }
      })
      .catch((reason: unknown) => {
        if (active) onError(describeError(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [task.id, onError]);
  async function add() {
    if (!adding || !title.trim() || busy || loading) return;
    onBusy(true);
    onError("");
    try {
      const child = await api.createTask({
        requestId,
        taskId: requestId,
        task: {
          title: title.trim(),
          parentId: task.id,
          projectId: task.projectId,
          sectionId: task.sectionId,
          priority: 4,
          kind: adding,
          durationMinutes: adding === "step" ? minutes : 0,
        },
      });
      setChildren((current) => [...current, child]);
      setTitle("");
      setRequestId(crypto.randomUUID());
      onChanged();
    } catch (reason) {
      onError(describeError(reason));
    } finally {
      onBusy(false);
    }
  }
  async function finish(child: Task) {
    onBusy(true);
    onError("");
    try {
      const error = await onComplete(child);
      if (error) {
        onError(error);
        return;
      }
      const saved = await api.getTask({ name: child.name });
      setChildren((current) =>
        current.map((value) => (value.id === saved.id ? saved : value)),
      );
      onChanged();
    } catch (reason) {
      onError(describeError(reason));
    } finally {
      onBusy(false);
    }
  }
  async function remove(child: Task) {
    if (busy) return;
    onBusy(true);
    onError("");
    try {
      await onDelete(child);
      setChildren((current) =>
        current.filter((value) => value.id !== child.id),
      );
      setDeleting("");
      onChanged();
    } catch (reason) {
      onError(describeError(reason));
    } finally {
      onBusy(false);
    }
  }
  async function more() {
    onBusy(true);
    try {
      const result = await api.listTasks({
        parentId: task.id,
        pageSize: 100,
        pageToken: page,
        includeCompleted: true,
      });
      setChildren((current) => [...current, ...result.tasks]);
      setPage(result.nextPageToken);
    } catch (reason) {
      onError(describeError(reason));
    } finally {
      onBusy(false);
    }
  }
  async function reorder(moving: Task, target: Task, after: boolean) {
    if (busy || loading || moving.kind !== target.kind) return false;
    const sortOrder = taskDropOrder(
      children.filter((child) => child.kind === moving.kind),
      moving.id,
      target.id,
      after,
    );
    if (sortOrder === undefined || sortOrder === moving.sortOrder) return false;
    onBusy(true);
    onError("");
    try {
      const saved = await api.updateTask({
        requestId: crypto.randomUUID(),
        etag: moving.etag,
        task: { name: moving.name, sortOrder },
        updateMask: { paths: ["sort_order"] },
      });
      setChildren((current) =>
        current
          .map((child) => (child.id === saved.id ? saved : child))
          .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)),
      );
      onChanged();
      return true;
    } catch (reason) {
      onError(describeError(reason));
      return false;
    } finally {
      onBusy(false);
    }
  }
  return (
    <TaskDragProvider
      onError={onError}
      onDrop={async (moving, target) =>
        target.kind === "row"
          ? reorder(moving, target.task, target.position === "after")
          : false
      }
    >
      <section className="task-children" aria-label="Subtasks and steps">
        {loading && (
          <span className="visually-hidden" role="status">
            Reading subtasks and steps…
          </span>
        )}
        {(["step", "task"] as const).map((kind) => {
          const rows = children.filter(
            (child) => (child.kind || "task") === kind,
          );
          return (
            <section
              className="task-child-group"
              aria-label={kind === "step" ? "Steps" : "Subtasks"}
              key={kind}
            >
              <h3>
                {kind === "step" ? "Steps" : "Subtasks"}
                <span>
                  {loading
                    ? "…"
                    : `${rows.filter((child) => child.completed).length}/${rows.length}`}
                </span>
                <button
                  type="button"
                  className="text-button task-child-add-trigger"
                  disabled={busy || loading}
                  onClick={(event) => {
                    addTrigger.current = event.currentTarget;
                    if (adding === kind) input.current?.focus();
                    else setAdding(kind);
                  }}
                >
                  <Plus size={15} />
                  {kind === "step" ? "Add step" : "Add subtask"}
                </button>
              </h3>
              {(loading || !rows.length) && (
                <p className="muted child-empty">
                  {kind === "step"
                    ? "Add a small action to arrange in your week."
                    : "Add another outcome or part of this task."}
                </p>
              )}
              {rows.map((child) => (
                <TaskChildRow
                  key={child.id}
                  child={child}
                  peers={rows}
                  busy={busy || loading}
                  today={today}
                  onOpen={() => onOpen(child.id)}
                  onComplete={() => void finish(child)}
                  onDelete={() => setDeleting(child.id)}
                  confirmation={
                    deleting === child.id && (
                      <div
                        className="child-delete-confirm"
                        role="alert"
                        onKeyDown={deletion.onKeyDown}
                      >
                        <span>
                          Delete this {kind === "step" ? "step" : "subtask"}
                          {child.childCount ? " and its children" : ""}?
                        </span>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => setDeleting("")}
                        >
                          Keep
                        </button>
                        <button
                          ref={deletion.confirmButton}
                          type="button"
                          className="text-button danger"
                          disabled={busy}
                          onClick={() => void remove(child)}
                        >
                          Delete {kind === "step" ? "step" : "subtask"}
                        </button>
                      </div>
                    )
                  }
                />
              ))}
              {adding === kind && (
                <div className="task-child-add">
                  <div className="inline-add">
                    <Plus size={15} />
                    <input
                      ref={input}
                      aria-label={kind === "step" ? "New step" : "New subtask"}
                      placeholder={
                        kind === "step"
                          ? "Add an executable step"
                          : "Add subtask"
                      }
                      value={title}
                      disabled={busy}
                      onChange={(event) => setTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.nativeEvent.isComposing) return;
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setAdding(null);
                          addTrigger.current?.focus();
                        } else if (event.key === "Enter") {
                          event.preventDefault();
                          event.stopPropagation();
                          void add();
                        }
                      }}
                    />
                    {kind === "step" && (
                      <select
                        aria-label="Step estimate"
                        value={minutes}
                        disabled={busy}
                        onChange={(event) =>
                          setMinutes(Number(event.target.value))
                        }
                      >
                        {[15, 30, 45, 60, 90, 120].map((value) => (
                          <option value={value} key={value}>
                            {value}m
                          </option>
                        ))}
                      </select>
                    )}
                    <button
                      type="button"
                      className="text-button"
                      disabled={busy || loading || !title.trim()}
                      onClick={() => void add()}
                    >
                      Add
                    </button>
                  </div>
                </div>
              )}
            </section>
          );
        })}
        {page && (
          <button
            type="button"
            className="text-button"
            disabled={busy}
            onClick={() => void more()}
          >
            Load more children
          </button>
        )}
      </section>
    </TaskDragProvider>
  );
}
