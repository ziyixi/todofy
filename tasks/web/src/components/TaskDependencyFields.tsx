import { useEffect, useState } from "react";
import { Link2, Plus, X } from "lucide-react";
import { RpcStatusError } from "@ziyixi/proto/http-client";
import type { TaskDependency } from "@ziyixi/proto/todofy/ui/v1/plus_service_pb";
import { api, describeError, type Task } from "../api";
import { planningApi } from "../task-planning";

export function TaskDependencyFields({
  task,
  busy,
  onOpen,
  onChanged,
}: {
  task: Task;
  busy: boolean;
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const [dependencies, setDependencies] = useState<TaskDependency[]>([]);
  const [related, setRelated] = useState<Record<string, Task>>({});
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState(false);
  const [results, setResults] = useState<Task[]>([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true);
    void planningApi
      .readPlan({})
      .then(async (value) => {
        let edges = (value.plan?.dependencies || []).filter(
          (edge) => edge.taskId === task.id,
        );
        const missing: string[] = [];
        const tasks = await Promise.all(
          edges.map(async (edge) => {
            try {
              return await api.getTask({
                name: `tasks/${edge.prerequisiteId}`,
              });
            } catch (reason) {
              if (
                reason instanceof RpcStatusError &&
                reason.status.reason === "NOT_FOUND"
              ) {
                missing.push(edge.prerequisiteId);
                return undefined;
              }
              throw reason;
            }
          }),
        );
        if (active && missing.length) {
          const settled = await planningApi.resolveDependencies({
            taskIds: missing,
            requestId: crypto.randomUUID(),
          });
          edges = settled.dependencies.filter(
            (edge) => edge.taskId === task.id,
          );
        }
        if (active) {
          setDependencies(edges);
          setRelated(
            Object.fromEntries(
              tasks.flatMap((value) => (value ? [[value.id, value]] : [])),
            ),
          );
        }
      })
      .catch((reason: unknown) => {
        if (active) setError(describeError(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [task.id]);
  useEffect(() => {
    if (!picking || !query.trim()) {
      setResults([]);
      return;
    }
    let active = true;
    const timer = window.setTimeout(() => {
      void api
        .listTasks({ view: "search", query: query.trim(), pageSize: 20 })
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
  const done = (edge: TaskDependency) => {
    const prerequisite = related[edge.prerequisiteId];
    if (prerequisite)
      return (
        prerequisite.completed ||
        Boolean(
          prerequisite.recurrence &&
          prerequisite.completedCount > edge.baselineCompletedCount,
        )
      );
    return edge.done;
  };
  const blocked = dependencies.some((edge) => !done(edge));
  async function change(prerequisiteId: string, waits: boolean) {
    setSaving(true);
    setError("");
    try {
      const response = await planningApi.setTaskDependency({
        taskId: task.id,
        prerequisiteId,
        waits,
        requestId: crypto.randomUUID(),
      });
      setDependencies(
        response.dependencies.filter((edge) => edge.taskId === task.id),
      );
      const added = results.find((value) => value.id === prerequisiteId);
      if (added) setRelated((current) => ({ ...current, [added.id]: added }));
      setPicking(false);
      setQuery("");
      onChanged();
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
        {loading && (
          <span className="dependency-loading" role="status">
            Checking…
          </span>
        )}
        {blocked && <span className="dependency-blocked">Blocked</span>}
      </h3>
      {dependencies.map((edge) => (
        <div
          className={`task-dependency-row ${done(edge) ? "is-done" : ""}`}
          key={edge.prerequisiteId}
        >
          <button
            type="button"
            className="text-button"
            onClick={() => onOpen(edge.prerequisiteId)}
          >
            {related[edge.prerequisiteId]?.title || "Referenced task"}
          </button>
          {done(edge) && <span className="muted">Done</span>}
          <button
            type="button"
            className="icon-button"
            disabled={busy || saving}
            aria-label={`Remove dependency ${related[edge.prerequisiteId]?.title || edge.prerequisiteId}`}
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
          disabled={busy || saving || loading || task.completed}
          onClick={() => {
            setError("");
            setPicking(true);
          }}
        >
          <Plus size={13} /> Add dependency
        </button>
      )}
    </section>
  );
}
