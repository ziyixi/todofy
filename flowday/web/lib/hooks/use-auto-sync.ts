"use client";

import { useEffect } from "react";
import { useTodoistStore } from "@/features/todoist/store";
import { startAutoSync } from "./auto-sync";

/** Runs the visibility-aware automatic Todoist sync (./auto-sync.ts) while a task source is configured. */
export function useAutoSync() {
  const configured = useTodoistStore((s) => s.taskSource === "tasks" || s.hasApiKey);

  useEffect(() => {
    if (!configured) return;
    const autoSync = startAutoSync({
      now: () => Date.now(),
      isVisible: () => document.visibilityState === "visible",
      setTimer: (callback, ms) => window.setTimeout(callback, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      sync: () => void useTodoistStore.getState().sync("auto"),
    });
    const onVisibility = () => autoSync.visibilityChanged();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      autoSync.stop();
    };
  }, [configured]);
}
