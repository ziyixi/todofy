import { useEffect, useState } from "react";
import { Link2, Plus, X } from "lucide-react";
import { api, describeError, type Task } from "../api";

/** What the task waits for, as GetTask answered it; each change is one write of the task's dependencies. */
export function TaskDependencyFields({
  task,
  busy,
  onOpen,
  onSaved,
}: {
  task: Task;
  busy: boolean;
  onOpen: (id: string) => void;
  /** The task as Tasks saved it: a dependency write changes its etag. */
  onSaved: (task: Task) => void;
}) {
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState(false);
  const [results, setResults] = useState<Task[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dependencies = task.dependencies;
  useEffect(() => {
    if (!picking || !query.trim()) {
      setResults([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void api
        .listTasks({ view: "all", query: query.trim(), pageSize: 20 })
        .then((value) => {
          if (active)
            setResults(
              value.tasks.filter(
                (value) =>
                  value.id !== task.id &&
                  !dependencies.some(
                    (edge) => edge.prerequisiteId === value.id,
                  ),
              ),
            );
        })
        .catch((reason: unknown) => {
          if (active) setError(describeError(reason));
        });
    }, 220);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [picking, query, task.id, dependencies]);
  const blocked = dependencies.some((edge) => !edge.done);
  async function change(prerequisiteId: string, waits: boolean) {
    setSaving(true);
    setError("");
    try {
      const prerequisites = [
        ...dependencies
          .map((edge) => edge.prerequisiteId)
          .filter((id) => id !== prerequisiteId),
        ...(waits ? [prerequisiteId] : []),
      ];
      const saved = await api.updateTask({
        requestId: crypto.randomUUID(),
        etag: task.etag,
        task: {
          name: task.name,
          dependencies: prerequisites.map((id) => ({ prerequisiteId: id })),
        },
        updateMask: { paths: ["dependencies"] },
      });
      setPicking(false);
      setQuery("");
      onSaved(saved);
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="task-dependencies" aria-label="Task dependencies">
      <h3>
        <Link2 size={13} /> Depends on{" "}
        {blocked && <span className="dependency-blocked">Blocked</span>}
      </h3>
      {dependencies.map((edge) => (
        <div
          className={`task-dependency-row ${edge.done ? "is-done" : ""}`}
          key={edge.prerequisiteId}
        >
          <button
            type="button"
            className="text-button"
            onClick={() => onOpen(edge.prerequisiteId)}
          >
            {edge.title || "Referenced task"}
          </button>
          {edge.done && <span className="muted">Done</span>}
          <button
            type="button"
            className="icon-button"
            disabled={busy || saving}
            aria-label={`Remove dependency ${edge.title || edge.prerequisiteId}`}
            onClick={() => void change(edge.prerequisiteId, false)}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      {error && (
        <p className="error-message" role="alert">
          {error}
        </p>
      )}
      {picking ? (
        <>
          <input
            className="task-dependency-search"
            aria-label="Search prerequisites"
            placeholder="Search tasks to wait for…"
            autoFocus
            value={query}
            maxLength={200}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setPicking(false);
              }
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                if (results[0]) void change(results[0].id, true);
              }
            }}
          />
          <div
            className="task-dependency-results"
            role="listbox"
            aria-label="Prerequisite tasks"
          >
            {results.map((value) => (
              <button
                type="button"
                role="option"
                aria-selected={false}
                key={value.id}
                disabled={saving}
                onClick={() => void change(value.id, true)}
              >
                {value.title}
              </button>
            ))}
          </div>
          {query.trim() && !results.length && (
            <p className="muted child-empty">No matching tasks.</p>
          )}
          <button
            type="button"
            className="text-button"
            onClick={() => setPicking(false)}
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          className="text-button"
          disabled={busy || saving || task.completed}
          onClick={() => {
            setError("");
            setPicking(true);
          }}
        >
          <Plus size={13} /> Add dependency
        </button>
      )}
      <div className="task-dependents" aria-label="Dependent tasks">
        <h3>
          <Link2 size={13} /> Dependents
        </h3>
        {task.dependents.length ? (
          task.dependents.map((dependent) => (
            <div className="task-dependency-row" key={dependent.taskId}>
              <button
                type="button"
                className="text-button"
                onClick={() => onOpen(dependent.taskId)}
              >
                {dependent.title || "Referenced task"}
              </button>
            </div>
          ))
        ) : (
          <p className="muted child-empty">No tasks depend on this task.</p>
        )}
      </div>
    </section>
  );
}
