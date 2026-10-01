"use client";

import { useEffect } from "react";
import { useTodoistStore } from "@/features/todoist/store";

export function useAutoSync() {
  const lastSyncAt = useTodoistStore((s) => s.lastSyncAt);

  useEffect(() => {
    // Only auto-sync if we've successfully synced before (meaning API key is configured)
    if (!lastSyncAt) return;

    const interval = setInterval(() => {
      useTodoistStore.getState().sync();
    }, 60_000);

    return () => clearInterval(interval);
  }, [lastSyncAt]);
}
