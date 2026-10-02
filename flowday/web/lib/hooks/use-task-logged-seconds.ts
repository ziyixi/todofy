"use client";

import { useEffect, useState } from "react";
import { loadEntriesByDate, loadEntriesByTask } from "@/lib/client/flowday-api";
import {
  mapEntrySecondsByTask,
  sumEntryDurationSeconds,
  type DurationEntryLike,
  type TaskDurationEntryLike,
} from "@/lib/utils/time-entries";

export function useTaskLoggedSeconds(taskId: string, revision: number): number {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    loadEntriesByTask(taskId)
      .then((entries: DurationEntryLike[] | null) => {
        if (!cancelled) {
          setSeconds(sumEntryDurationSeconds(entries));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [taskId, revision]);

  return taskId ? seconds : 0;
}

export function useLoggedSecondsByTaskForDate(
  date: string,
  revision?: number
): Record<string, number> {
  const [secondsByTask, setSecondsByTask] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;
    loadEntriesByDate(date)
      .then((entries: TaskDurationEntryLike[] | null) => {
        if (cancelled) return;
        setSecondsByTask(mapEntrySecondsByTask(entries));
      })
      .catch(() => {
        if (!cancelled) setSecondsByTask({});
      });

    return () => {
      cancelled = true;
    };
  }, [date, revision]);

  return secondsByTask;
}
