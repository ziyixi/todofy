import { useCallback, useEffect, useRef, useState } from "react";
import { api, describeError, type Task } from "./api";
import type { Route } from "./routes";

export function useTaskView(
  route: Route,
  search: string,
  date: string,
  orderBy: string,
  includeCompleted: boolean,
) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [nextPage, setNextPage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const read = useCallback(
    async (pageToken = "") => {
      const request = ++generation.current;
      setLoading(true);
      setError("");
      try {
        const response = await api.listTasks({
          view: route.page,
          projectId: route.page === "project" ? route.id : "",
          labelId: route.page === "label" ? route.id : "",
          filterId: route.page === "filter" ? route.id : "",
          query: search,
          date,
          pageSize: 100,
          pageToken,
          orderBy,
          includeCompleted,
        });
        if (generation.current !== request) return;
        setTasks((current) =>
          pageToken
            ? [
                ...current,
                ...response.tasks.filter(
                  (task) => !current.some((item) => item.id === task.id),
                ),
              ]
            : response.tasks,
        );
        setNextPage(response.nextPageToken);
      } catch (reason) {
        if (generation.current === request) setError(describeError(reason));
      } finally {
        if (generation.current === request) setLoading(false);
      }
    },
    [route.page, route.id, search, date, orderBy, includeCompleted],
  );
  useEffect(() => {
    if (["plan", "focus", "mail", "catalog", "settings"].includes(route.page))
      return;
    setTasks([]);
    setNextPage("");
    const timer = window.setTimeout(
      () => void read(),
      route.page === "search" ? 220 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      generation.current += 1;
    };
  }, [read, route.page]);
  const replace = useCallback(
    (task: Task) =>
      setTasks((current) =>
        current.map((item) => (item.id === task.id ? task : item)),
      ),
    [],
  );
  const remove = useCallback(
    (id: string) =>
      setTasks((current) => current.filter((task) => task.id !== id)),
    [],
  );
  return {
    tasks,
    setTasks,
    nextPage,
    loading,
    error,
    setError,
    read,
    replace,
    remove,
  };
}
