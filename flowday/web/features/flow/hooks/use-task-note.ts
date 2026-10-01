"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJsonNoStore, jsonRequestInit } from "@/lib/client/http";

interface TaskNoteResponse {
  content?: string | null;
}

export function useTaskNote(taskId: string, flowDate: string) {
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchJsonNoStore<TaskNoteResponse>(
      `/api/notes?taskId=${encodeURIComponent(taskId)}&date=${encodeURIComponent(flowDate)}`
    )
      .then((data) => {
        if (!cancelled && data?.content) {
          setNote(data.content);
          setShowNote(true);
        }
        if (!cancelled) setLoaded(true);
      })
      .catch(() => {
        if (!cancelled) setLoaded(true);
      });

    return () => {
      cancelled = true;
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [flowDate, taskId]);

  const updateNote = useCallback(
    (content: string) => {
      setNote(content);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        fetch(
          "/api/notes",
          jsonRequestInit("PUT", {
            taskId,
            flowDate,
            content,
          })
        ).catch(() => {});
      }, 500);
    },
    [flowDate, taskId]
  );

  const toggle = useCallback(() => setShowNote((value) => !value), []);

  return {
    note,
    showNote,
    loaded,
    hasNote: loaded && note.length > 0,
    updateNote,
    toggle,
  };
}
