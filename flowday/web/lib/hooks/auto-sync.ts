/**
 * When the page asks the Worker to sync Todoist (../../docs/design.md "Todoist sync"): once when the page opens,
 * then every 10 minutes while the page is visible, and again on becoming visible when the last attempt is older
 * than 5 minutes. Nothing runs while the page is hidden (a background tab or a minimised PWA window). The Worker
 * throttles as well (5 minutes for automatic syncs, across tabs and devices), so a second tab costs nothing.
 */
export const AUTO_SYNC_INTERVAL_MS = 10 * 60_000;
export const RESYNC_ON_VISIBLE_AFTER_MS = 5 * 60_000;

export interface AutoSyncEnvironment {
  now: () => number;
  isVisible: () => boolean;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  sync: () => void;
}

export interface AutoSync {
  /** The page became visible or hidden. */
  visibilityChanged: () => void;
  stop: () => void;
}

export function startAutoSync(env: AutoSyncEnvironment): AutoSync {
  let lastAttempt = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;
  let stopped = false;

  const cancel = () => {
    if (timer !== null) env.clearTimer(timer);
    timer = null;
  };
  const run = () => {
    lastAttempt = env.now();
    env.sync();
  };
  const schedule = () => {
    cancel();
    if (stopped || !env.isVisible()) return;
    const wait = Math.max(0, lastAttempt + AUTO_SYNC_INTERVAL_MS - env.now());
    timer = env.setTimer(() => {
      timer = null;
      if (!env.isVisible()) return;
      run();
      schedule();
    }, wait);
  };

  if (env.isVisible()) run();
  schedule();

  return {
    visibilityChanged() {
      if (stopped) return;
      if (!env.isVisible()) {
        cancel();
        return;
      }
      if (env.now() - lastAttempt >= RESYNC_ON_VISIBLE_AFTER_MS) run();
      schedule();
    },
    stop() {
      stopped = true;
      cancel();
    },
  };
}
