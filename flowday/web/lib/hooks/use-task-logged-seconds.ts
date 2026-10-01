"use client";

import { useEffect, useState } from "react";
import { fetchJsonNoStore } from "@/lib/client/http";
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
    fetchJsonNoStore<DurationEntryLike[]>(
      `/api/entries?taskId=${encodeURIComponent(taskId)}`
    )
      .then((entries) => {
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
    fetchJsonNoStore<TaskDurationEntryLike[]>(
      `/api/entries?date=${encodeURIComponent(date)}`
    )
      .then((entries) => {
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
