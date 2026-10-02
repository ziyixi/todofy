"use client";

import { useEffect, useState } from "react";
import { useTimerStore } from "@/features/timer/store";
import { loadNotesByDate } from "@/lib/client/flowday-api";
import { useLoggedSecondsByTaskForDate } from "@/lib/hooks/use-task-logged-seconds";

export function useDayNotesMap(date: string): Record<string, string> {
  const [notesByTask, setNotesByTask] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    loadNotesByDate(date)
      .then((notes) => {
        if (cancelled) return;
        setNotesByTask(notes ?? {});
      })
      .catch(() => {
        if (!cancelled) setNotesByTask({});
      });

    return () => {
      cancelled = true;
    };
  }, [date]);

  return notesByTask;
}

export function useDayLoggedSecondsMap(date: string): Record<string, number> {
  const entryRevision = useTimerStore((state) => state.entryRevision);
  return useLoggedSecondsByTaskForDate(date, entryRevision);
}
