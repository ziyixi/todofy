import { useEffect, useRef, useState } from "react";

/** What a launched URL asks of Tasks. */
export interface Launch {
  /** The route to show (`#/focus`), or "" to keep the current page. */
  hash: string;
  /** `?task=<id>`: open that task. */
  taskId: string;
  /** `?review=1`: open Plan's weekly review checklist. */
  review: boolean;
  /** `?mail=<eventId>`: Mail shows that mail's full summary (linked from a long mail task's description). */
  mailId: string;
  /** `?add=1`: open Quick add. */
  quickAdd: boolean;
}

declare global {
  // Launch Handler API (Chrome 102), not yet in TypeScript's DOM types.
  interface LaunchParams {
    readonly targetURL?: string;
  }
  interface Window {
    launchQueue?: {
      setConsumer(consumer: (params: LaunchParams) => void): void;
    };
  }
}

// The URL this document loaded, before the load path removes its one-time parameters.
const loadedUrl = window.location.href;

/** What a launched URL asks for, or undefined for a URL outside this origin. */
export function readLaunch(target: string, origin: string): Launch | undefined {
  const url = URL.parse(target);
  if (url?.origin !== origin) return undefined;
  const review = url.searchParams.get("review") === "1";
  return {
    // A review link without a route opens Plan, where the checklist is.
    hash: url.hash || (review ? "#/plan" : ""),
    taskId: url.searchParams.get("task") ?? "",
    review,
    mailId: url.searchParams.get("mail") ?? "",
    quickAdd: url.searchParams.get("add") === "1",
  };
}

/**
 * Calls `act` for every launch except the one that opened this document: Chrome queues that launch too,
 * and the load path already handles its URL. A later launch acts even with the same URL (Quick add twice).
 */
export function launchConsumer(
  initialUrl: string,
  origin: string,
  act: (launch: Launch) => void,
): (params: LaunchParams) => void {
  let first = true;
  return ({ targetURL }) => {
    const opened = first && targetURL === initialUrl;
    first = false;
    const launch =
      targetURL && !opened ? readLaunch(targetURL, origin) : undefined;
    if (launch) act(launch);
  };
}

/**
 * Hands launches into this window to the latest `onLaunch`. The manifest's `launch_handler` is
 * `focus-existing`: Chrome focuses the open app window without navigating it and queues the URL here.
 * Plain tabs and other browsers never call the consumer, and load URLs as pages.
 */
export function useLaunchQueue(onLaunch: (launch: Launch) => void): void {
  const latest = useRef(onLaunch);
  useEffect(() => {
    latest.current = onLaunch;
  });
  // One consumer for the page's life, so StrictMode's second effect does not see the first launch again.
  const [consume] = useState(() =>
    launchConsumer(loadedUrl, window.location.origin, (launch) =>
      latest.current(launch),
    ),
  );
  useEffect(() => window.launchQueue?.setConsumer(consume), [consume]);
}
