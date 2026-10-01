"use client";

import { useEffect, useRef } from "react";
import { useFlowStore } from "@/features/flow/store";
import { useTimerStore } from "@/features/timer/store";
import { useTodoistStore } from "@/features/todoist/store";
import { prefetchCsrf } from "@/lib/client/http";

export function useHydration() {
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current) return;
    hydrated.current = true;

    prefetchCsrf();
    void Promise.all([
      useTodoistStore.getState().hydrate(),
      useFlowStore.getState().hydrate(),
      useTimerStore.getState().hydrateSession(),
    ]);
  }, []);

  useEffect(() => {
    const rehydrateTimerSession = () => {
      if (document.visibilityState === "hidden") return;
      void useTimerStore.getState().hydrateSession();
    };

    window.addEventListener("focus", rehydrateTimerSession);
    document.addEventListener("visibilitychange", rehydrateTimerSession);

    return () => {
      window.removeEventListener("focus", rehydrateTimerSession);
      document.removeEventListener("visibilitychange", rehydrateTimerSession);
    };
  }, []);
}
