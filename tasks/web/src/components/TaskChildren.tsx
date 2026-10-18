import { useEffect, useState } from "react";
import {
  CalendarDays,
  Check,
  Circle,
  Flag,
  Plus,
  Repeat2,
  Trash2,
} from "lucide-react";
import { api, describeError, type Task } from "../api";
import { dateLabel, todayDate } from "../dates";
import "./task-children.css";

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
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState("");
  const [adding, setAdding] = useState<"task" | "step">("task");
  const [title, setTitle] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [deleting, setDeleting] = useState("");
  useEffect(() => {
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
    if (!title.trim() || busy || loading) return;
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
  return (
    <section className="task-children" aria-label="Subtasks and steps">
      {loading && (
        <span className="visually-hidden" role="status">
          Reading subtasks and steps…
        </span>
      )}
      {(["task", "step"] as const).map((kind) => {
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
            </h3>
            {(loading || !rows.length) && (
              <p className="muted child-empty">
                {kind === "step"
                  ? "Add a small action to arrange in your week."
                  : "Add another outcome or part of this task."}
              </p>
            )}
            {rows.map((child) => (
              <div
                className={`task-child-row ${child.completed ? "is-completed" : ""}`}
                key={child.id}
              >
                <button
                  type="button"
                  className={`complete-button priority-${child.priority}`}
                  aria-label={`${child.completed ? "Reopen" : "Complete"} ${child.title}`}
                  disabled={busy}
                  onClick={() => void finish(child)}
                >
                  {child.completed ? <Check size={13} /> : <Circle size={18} />}
                </button>
                <button
                  type="button"
                  className="task-child-title"
                  aria-label={child.title}
                  onClick={() => onOpen(child.id)}
                >
                  <span>{child.title}</span>
                  {(child.dueDate || child.deadline || child.recurrence) && (
                    <span className="task-child-meta">
                      {child.dueDate && (
                        <span
                          className={
                            child.dueDate < today && !child.completed
                              ? "child-overdue"
                              : ""
                          }
                        >
                          <CalendarDays size={11} />
                          {dateLabel(child.dueDate, today)}
                        </span>
                      )}
                      {child.recurrence && (
                        <Repeat2 size={11} aria-label="Repeating" />
                      )}
                      {child.deadline && (
                        <span>
                          <Flag size={11} />
                          {dateLabel(child.deadline, today)}
                        </span>
                      )}
                    </span>
                  )}
                </button>
                {kind === "step" && (
                  <span className="child-estimate">
                    {child.durationMinutes
                      ? `${child.durationMinutes}m`
                      : "No estimate"}
                  </span>
                )}
                <button
                  type="button"
                  className="icon-button child-delete"
                  aria-label={`Delete ${kind === "step" ? "step" : "subtask"} ${child.title}`}
                  disabled={busy}
                  onClick={() => setDeleting(child.id)}
                >
                  <Trash2 size={14} />
                </button>
                {deleting === child.id && (
                  <div className="child-delete-confirm" role="alert">
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
                      type="button"
                      className="text-button danger"
                      disabled={busy}
                      onClick={() => void remove(child)}
                    >
                      Delete {kind === "step" ? "step" : "subtask"}
                    </button>
                  </div>
                )}
              </div>
            ))}
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
      <div className="task-child-add">
        <div className="child-kind-tabs" role="group" aria-label="Add a child">
          <button
            type="button"
            aria-pressed={adding === "task"}
            onClick={() => setAdding("task")}
          >
            Subtask
          </button>
          <button
            type="button"
            aria-pressed={adding === "step"}
            onClick={() => setAdding("step")}
          >
            Step
          </button>
        </div>
        <div className="inline-add">
          <Plus size={15} />
          <input
            aria-label={adding === "step" ? "New step" : "New subtask"}
            placeholder={
              adding === "step" ? "Add an executable step" : "Add subtask"
            }
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                void add();
              }
            }}
          />
          {adding === "step" && (
            <select
              aria-label="Step estimate"
              value={minutes}
              onChange={(event) => setMinutes(Number(event.target.value))}
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
    </section>
  );
}
