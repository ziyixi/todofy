import { useEffect, useLayoutEffect, useRef } from "react";

/** As in Plan: a minute or more hidden is long enough for the list, its counts or the day to change. */
export const RETURN_REFRESH_MS = 60_000;

/** Runs `refresh` when the page becomes visible again after being hidden for RETURN_REFRESH_MS or more. */
export function useReturnRefresh(refresh: () => void) {
  const latest = useRef(refresh);
  useLayoutEffect(() => {
    latest.current = refresh;
  });
  useEffect(() => {
    let hiddenAt = document.visibilityState === "hidden" ? Date.now() : 0;
    const change = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = 0;
      if (away >= RETURN_REFRESH_MS) latest.current();
    };
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
}
