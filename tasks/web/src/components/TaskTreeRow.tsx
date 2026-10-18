import { useEffect, useId, useRef, useState } from "react";
import { api, describeError, type Task } from "../api";
import { TaskRow, type TaskRowProps } from "./TaskRow";
import "./task-tree.css";

type RowContext = Omit<
  TaskRowProps,
  | "task"
  | "parentTitle"
  | "expanded"
  | "onToggleChildren"
  | "childListId"
  | "childContent"
  | "peers"
>;

export function TaskTreeRow({
  task,
  row,
  parentTitle,
  listedIds,
  showCompleted,
  orderBy,
  ancestors = [],
  peers,
}: {
  task: Task;
  row: RowContext;
  parentTitle?: string;
  listedIds: ReadonlySet<string>;
  showCompleted: boolean;
  orderBy: string;
  ancestors?: readonly string[];
  peers?: readonly Task[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<Task[]>([]);
  const [nextPage, setNextPage] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const childListId = useId();
  useEffect(() => {
    if (!expanded) return;
    const current = ++generation.current;
    setPending(true);
    setError("");
    void api
      .listTasks({
        parentId: task.id,
        pageSize: 100,
        orderBy,
        includeCompleted: true,
      })
      .then((value) => {
        if (generation.current !== current) return;
        setChildren(value.tasks);
        setNextPage(value.nextPageToken);
        setLoaded(true);
      })
      .catch((reason: unknown) => {
        if (generation.current === current) setError(describeError(reason));
      })
      .finally(() => {
        if (generation.current === current) setPending(false);
      });
    return () => {
      generation.current++;
    };
  }, [expanded, task, orderBy, attempt]);

  async function more() {
    if (pending || !nextPage) return;
    const current = generation.current;
    setPending(true);
    setError("");
    try {
      const value = await api.listTasks({
        parentId: task.id,
        pageSize: 100,
        pageToken: nextPage,
        orderBy,
        includeCompleted: true,
      });
      if (generation.current !== current) return;
      setChildren((old) => [
        ...old,
        ...value.tasks.filter(
          (child) => !old.some((known) => known.id === child.id),
        ),
      ]);
      setNextPage(value.nextPageToken);
    } catch (reason) {
      if (generation.current === current) setError(describeError(reason));
    } finally {
      if (generation.current === current) setPending(false);
    }
  }
  const path = [...ancestors, task.id];
  const eligible = children.filter(
    (child) => (showCompleted || !child.completed) && !path.includes(child.id),
  );
  // Today/search may already list a dated or matching child independently. Keep that view intact.
  const visible = eligible.filter((child) => !listedIds.has(child.id));
  let emptyMessage = "No subtasks.";
  if (eligible.length)
    emptyMessage = "Subtasks are already listed in this view.";
  else if (children.length) emptyMessage = "All subtasks are completed.";
  return (
    <TaskRow
      {...row}
      task={task}
      parentTitle={parentTitle}
      peers={peers}
      expanded={expanded}
      onToggleChildren={() => setExpanded((value) => !value)}
      childListId={childListId}
      childContent={
        expanded && (
          <ul
            className="task-child-list"
            id={childListId}
            aria-label={`Subtasks of ${task.title}`}
            aria-busy={pending || (!loaded && !error)}
          >
            {visible.map((child) => (
              <TaskTreeRow
                key={child.id}
                task={child}
                row={row}
                parentTitle={task.title}
                peers={children}
                listedIds={listedIds}
                showCompleted={showCompleted}
                orderBy={orderBy}
                ancestors={path}
              />
            ))}
            {(pending || !loaded) && !error && (
              <li
                className={loaded ? "visually-hidden" : "task-tree-status"}
                role="status"
              >
                Reading subtasks…
              </li>
            )}
            {error && (
              <li className="task-tree-status error-message" role="alert">
                {error}{" "}
                <button
                  className="text-button"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  Retry
                </button>
              </li>
            )}
            {loaded && !pending && !error && !visible.length && (
              <li className="task-tree-status">{emptyMessage}</li>
            )}
            {nextPage && (
              <li>
                <button
                  className="text-button task-tree-more"
                  disabled={pending}
                  onClick={() => void more()}
                >
                  Load more subtasks
                </button>
              </li>
            )}
          </ul>
        )
      }
    />
  );
}
