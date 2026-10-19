import { useEffect, useState } from "react";
import type { Task } from "./api";
import { readTaskListPlanning, type PlanningTask } from "./task-planning";

const EMPTY: ReadonlyMap<string, PlanningTask> = new Map();

export function useTaskListProperties(tasks: readonly Task[]) {
  const [byId, setById] = useState(EMPTY);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let active = true;
    setUnavailable(false);
    if (!tasks.some((task) => !task.completed)) {
      setById(EMPTY);
      return;
    }
    void readTaskListPlanning(tasks)
      .then((values) => {
        if (active) setById(values);
      })
      .catch(() => {
        if (active) {
          setById(EMPTY);
          setUnavailable(true);
        }
      });
    return () => {
      active = false;
    };
  }, [tasks]);
  return { byId, unavailable };
}
