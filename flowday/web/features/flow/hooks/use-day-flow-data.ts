"use client";

import { useEffect, useState } from "react";
import { useTimerStore } from "@/features/timer/store";
import { fetchJsonNoStore } from "@/lib/client/http";
import { useLoggedSecondsByTaskForDate } from "@/lib/hooks/use-task-logged-seconds";

interface NoteRow {
  taskId: string;
  content: string;
}

export function useDayNotesMap(date: string): Record<string, string> {
  const [notesByTask, setNotesByTask] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    fetchJsonNoStore<NoteRow[]>(`/api/notes?date=${encodeURIComponent(date)}`)
      .then((rows) => {
        if (cancelled) return;
        const next: Record<string, string> = {};
        for (const row of rows ?? []) {
          next[row.taskId] = row.content ?? "";
        }
        setNotesByTask(next);
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
