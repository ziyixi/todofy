"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiGetOrNull, apiSendOk } from "@/lib/client/http";

interface TaskNoteResponse {
  content?: string | null;
}

/**
 * A note is saved after a pause in typing. Each save is one D1 row write, so the pause is 1.5 s (not every few
 * keystrokes). A pending save is flushed when the card closes or the page is hidden or unloads (the write is sent
 * with keepalive), instead of being dropped.
 */
export const NOTE_SAVE_DELAY_MS = 1500;

export function useTaskNote(taskId: string, flowDate: string) {
  const [note, setNote] = useState("");
  const [showNote, setShowNote] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<string | null>(null);

  const flush = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = null;
    const content = pendingRef.current;
    pendingRef.current = null;
    if (content !== null) void apiSendOk("PUT", "/api/notes", { taskId, flowDate, content });
  }, [flowDate, taskId]);

  useEffect(() => {
    let cancelled = false;
    void apiGetOrNull<TaskNoteResponse>(
      `/api/notes?taskId=${encodeURIComponent(taskId)}&date=${encodeURIComponent(flowDate)}`
    ).then((data) => {
      if (cancelled) return;
      if (data?.content) {
        setNote(data.content);
        setShowNote(true);
      }
      setLoaded(true);
    });

    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flushWhenHidden);

    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushWhenHidden);
      flush();
    };
  }, [flowDate, taskId, flush]);

  const updateNote = useCallback(
    (content: string) => {
      setNote(content);
      pendingRef.current = content;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(flush, NOTE_SAVE_DELAY_MS);
    },
    [flush]
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
