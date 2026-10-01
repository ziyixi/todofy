import { useEffect } from "react";
import { useTimerStore } from "@/features/timer/store";
import { usePopOutStore } from "@/lib/stores/pop-out-store";

const IDLE_THRESHOLD_MS = 10 * 60 * 1000;
const VISIBILITY_FALLBACK_MS = 10 * 60 * 1000;

function pauseAt(timestamp: number) {
  const state = useTimerStore.getState();
  if (state.status === "running") {
    void state.pauseTimer(timestamp);
  }
}

// Auto-pauses the running timer when the user is away from the screen.
// Prefers the precise IdleDetector API (true screen-lock detection + idle input
// detection) when permission is granted; otherwise falls back to a heuristic
// based on Page Visibility for both the main and pop-out windows.
export function useAutoIdlePause() {
  useEffect(() => {
    if (typeof window === "undefined") return;

    let cleanupIdle: (() => void) | null = null;
    let cleanupVisibility: (() => void) | null = null;
    let permissionStatus: PermissionStatus | null = null;
    let permissionListener: (() => void) | null = null;

    function teardown() {
      cleanupIdle?.();
      cleanupIdle = null;
      cleanupVisibility?.();
      cleanupVisibility = null;
    }

    function setupVisibilityFallback() {
      let hiddenAt: number | null = null;

      function isFullyHidden(): boolean {
        if (document.visibilityState !== "hidden") return false;
        const pip = usePopOutStore.getState().pipWindow;
        if (!pip || pip.closed) return true;
        try {
          return pip.document.visibilityState === "hidden";
        } catch {
          return true;
        }
      }

      function handleVisibility() {
        if (isFullyHidden()) {
          if (hiddenAt == null) hiddenAt = Date.now();
          return;
        }
        if (hiddenAt != null) {
          const awayMs = Date.now() - hiddenAt;
          const wasHiddenAt = hiddenAt;
          hiddenAt = null;
          if (awayMs > VISIBILITY_FALLBACK_MS) pauseAt(wasHiddenAt);
        }
      }

      document.addEventListener("visibilitychange", handleVisibility);
      const unsubscribePop = usePopOutStore.subscribe((s, prev) => {
        if (s.pipWindow && s.pipWindow !== prev.pipWindow) {
          s.pipWindow.document.addEventListener(
            "visibilitychange",
            handleVisibility
          );
        }
      });
      cleanupVisibility = () => {
        document.removeEventListener("visibilitychange", handleVisibility);
        unsubscribePop();
      };
    }

    async function trySetupIdleDetector(): Promise<boolean> {
      const Ctor = window.IdleDetector;
      if (!Ctor) return false;

      try {
        if (!permissionStatus) {
          permissionStatus = await navigator.permissions.query({
            name: "idle-detection" as PermissionName,
          });
          permissionListener = () => {
            void setup();
          };
          permissionStatus.addEventListener("change", permissionListener);
        }
        if (permissionStatus.state !== "granted") return false;

        const controller = new AbortController();
        const detector = new Ctor();

        detector.addEventListener("change", () => {
          const now = Date.now();
          if (detector.screenState === "locked") {
            // Screen lock fires roughly when locked — pause to "now".
            pauseAt(now);
          } else if (detector.userState === "idle") {
            // User has been idle for at least IDLE_THRESHOLD_MS — backdate.
            pauseAt(now - IDLE_THRESHOLD_MS);
          }
        });

        await detector.start({
          threshold: IDLE_THRESHOLD_MS,
          signal: controller.signal,
        });

        cleanupIdle = () => controller.abort();
        return true;
      } catch {
        return false;
      }
    }

    async function setup() {
      teardown();
      const ok = await trySetupIdleDetector();
      if (!ok) setupVisibilityFallback();
    }

    void setup();
    return () => {
      teardown();
      if (permissionStatus && permissionListener) {
        permissionStatus.removeEventListener("change", permissionListener);
      }
    };
  }, []);
}
