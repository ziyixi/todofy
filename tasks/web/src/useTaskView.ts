import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
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
  const visibleView = useRef("");
  const loadedPages = useRef(0);
  const loadedRows = useRef(0);
  const isListView = !["plan", "focus", "mail", "catalog"].includes(route.page);
  /** One page, or, with `keepRows`, the first pages until they hold that many rows (at most five). */
  const read = useCallback(
    async (pageToken = "", keepRows = 0) => {
      if (!isListView || (route.page === "search" && !search.trim())) {
        generation.current += 1;
        setTasks([]);
        setNextPage("");
        setError("");
        setLoading(false);
        return;
      }
      const request = ++generation.current;
      setLoading(true);
      setError("");
      try {
        const loaded: Task[] = [];
        const seen = new Set<string>();
        let token = pageToken;
        let pages = 0;
        do {
          const response = await api.listTasks({
            view: route.page,
            projectId: route.page === "project" ? route.id : "",
            labelId: route.page === "label" ? route.id : "",
            filterId: route.page === "filter" ? route.id : "",
            query: search,
            date,
            pageSize: 100,
            pageToken: token,
            orderBy,
            includeCompleted,
          });
          if (generation.current !== request) return;
          for (const task of response.tasks)
            if (!seen.has(task.id)) {
              seen.add(task.id);
              loaded.push(task);
            }
          token = response.nextPageToken;
          pages++;
        } while (token && loaded.length < keepRows && pages < 5);
        loadedPages.current = pageToken ? loadedPages.current + pages : pages;
        setTasks((current) =>
          pageToken
            ? [
                ...current,
                ...loaded.filter(
                  (task) => !current.some((item) => item.id === task.id),
                ),
              ]
            : loaded,
        );
        setNextPage(token);
      } catch (reason) {
        if (generation.current === request) setError(describeError(reason));
      } finally {
        if (generation.current === request) setLoading(false);
      }
    },
    [route.page, route.id, search, date, orderBy, includeCompleted, isListView],
  );
  const latestRead = useRef(read);
  useLayoutEffect(() => {
    latestRead.current = read;
    loadedRows.current = tasks.length;
  });
  // A mutation may finish after navigation; refresh the visible view, not its old closure.
  const readCurrent = useCallback(
    (pageToken = "") => latestRead.current(pageToken),
    [],
  );
  /** After a write: page 1 as before, or, when the owner loaded more pages, as many rows as were shown. */
  const refresh = useCallback(
    () =>
      latestRead.current("", loadedPages.current > 1 ? loadedRows.current : 0),
    [],
  );
  useEffect(() => {
    if (!isListView) return;
    if (route.page === "search" && !search.trim()) {
      void read();
      return;
    }
    const view = `${route.page}:${route.id || ""}`;
    if (visibleView.current !== view) {
      setTasks([]);
      setNextPage("");
      visibleView.current = view;
    }
    setNextPage("");
    setLoading(true);
    setError("");
    const timer = window.setTimeout(
      () => void read(),
      route.page === "search" ? 220 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      generation.current += 1;
    };
  }, [read, route.page, route.id, isListView]);
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
    read: readCurrent,
    refresh,
    replace,
    remove,
  };
}
