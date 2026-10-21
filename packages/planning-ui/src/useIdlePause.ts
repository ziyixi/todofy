// Pause when away, wired to the browser: the Idle Detection API (Chrome 94+), a heartbeat and a Web Lock, around
// the decision in idle-pause.ts. TypeScript's DOM library does not declare the API yet.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AWAY_AFTER_MS,
  BEAT_MS,
  IDLE_START,
  awayMinutes,
  idleStep,
  type IdleCommand,
  type IdleEvent,
  type WatchedTimer,
} from "./idle-pause";
import type { FocusState, TimerSnapshot } from "./model";

declare global {
  interface IdleDetector extends EventTarget {
    readonly userState: "active" | "idle" | null;
    readonly screenState: "locked" | "unlocked" | null;
    /** Rejects below a 60 s threshold, and without the idle-detection permission. */
    start(options: { threshold: number; signal: AbortSignal }): Promise<void>;
  }
  interface Window {
    IdleDetector?: {
      new (): IdleDetector;
      /** Needs a user gesture; answers "granted" or "denied". */
      requestPermission(): Promise<PermissionState>;
    };
  }
}

/** Held by the one Tasks window that watches, so with two windows open only one pauses. */
const WATCH_LOCK = "tasks.idle-pause";

export interface IdlePauseOptions {
  /** The owner's setting for this device, which the host keeps; undefined when it keeps none (no toggle). */
  enabled?: boolean;
  onEnabled?: (on: boolean) => void;
  /** The confirmed timer. */
  timer?: FocusState["timer"];
  /**
   * Sends a command through App's write queue, against the latest confirmed timer: answers what Tasks confirmed,
   * or undefined when the write failed (`quiet`: without showing that again).
   */
  send: (
    command: IdleCommand,
    quiet: boolean,
  ) => Promise<TimerSnapshot | undefined>;
  /** Called once Keep or Discard is confirmed. */
  onAnswered?: (kept: boolean) => void;
}
export interface IdlePause {
  /** Focus › Day's toggle; absent without the API or a host setting. */
  toggle?: {
    checked: boolean;
    /** The browser refused the permission on the last click. */
    refused: boolean;
    onChange: (checked: boolean) => void;
  };
  /** The question, until a change of the timer (its answer confirmed, or any other) drops it. */
  question?: {
    minutes: number;
    keep: () => void;
    discard: () => void;
  };
}

function watched(timer: FocusState["timer"]): WatchedTimer | undefined {
  return (
    timer && {
      taskId: timer.taskId,
      etag: timer.etag,
      countingUp: timer.status === "running" && timer.mode !== "pomodoro",
      ...(timer.pausedAt ? { pausedAt: Date.parse(timer.pausedAt) } : {}),
    }
  );
}

/**
 * Watches for the owner leaving a running count-up and pauses it at the moment they left; on their return it asks
 * whether to count that time. The permission is asked only from the toggle's click. One idle detector runs while
 * the setting is on, the permission is granted, this window holds the watch and a count-up runs or is paused by it.
 */
export function useIdlePause({
  enabled,
  onEnabled,
  timer,
  send,
  onAnswered,
}: IdlePauseOptions): IdlePause {
  const supported = "IdleDetector" in window;
  const [permission, setPermission] = useState<PermissionState>();
  const [refused, setRefused] = useState(false);
  const state = useRef(IDLE_START);
  const [phase, setPhase] = useState(IDLE_START.phase);
  // The latest callbacks, for commands answered after a render.
  const latest = useRef({ send, onAnswered });
  useEffect(() => {
    latest.current = { send, onAnswered };
  });
  const dispatch = useCallback((event: IdleEvent) => {
    const [next, command] = idleStep(state.current, event);
    state.current = next;
    setPhase(next.phase);
    if (command) void execute(command);
    async function execute(command: IdleCommand) {
      const saved = await latest.current.send(
        command,
        command.action === "pause" && command.retry,
      );
      if (!saved) return dispatch({ type: "failed", at: Date.now() });
      if (command.action === "resume")
        return latest.current.onAnswered?.(command.at !== undefined);
      const pausedAt = saved.timer?.pausedAt;
      if (saved.timer?.status === "paused" && pausedAt)
        dispatch({
          type: "paused",
          etag: saved.timerEtag,
          pausedAt: Date.parse(pausedAt),
        });
      else dispatch({ type: "failed", at: Date.now() });
    }
  }, []);

  // The permission as the browser holds it now: revoked later, the toggle shows off.
  useEffect(() => {
    if (!supported) return;
    let status: PermissionStatus | undefined;
    const changed = () => status && setPermission(status.state);
    navigator.permissions
      ?.query({ name: "idle-detection" as PermissionName })
      .then((answer) => {
        status = answer;
        changed();
        status.addEventListener("change", changed);
      })
      .catch(() => {});
    return () => status?.removeEventListener("change", changed);
  }, [supported]);

  const current = watched(timer);
  // Each confirmed change of the timer comes with a new etag; a read that changes nothing sends nothing.
  useEffect(() => {
    dispatch({ type: "timer", timer: current, at: Date.now() });
  }, [dispatch, current?.etag, current?.countingUp, current?.pausedAt]);

  // This window asks for the watch while there is anything to watch, and keeps it while its pause waits.
  const wanted = Boolean(
    supported &&
      enabled &&
      permission === "granted" &&
      (current?.countingUp ||
        ["pausing", "away", "asking"].includes(phase.name)),
  );
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!wanted) return;
    if (!("locks" in navigator)) {
      setHeld(true);
      return () => setHeld(false);
    }
    // Queued behind another window's watch, this one takes over when that window closes.
    const controller = new AbortController();
    let release = () => {};
    navigator.locks
      .request(
        WATCH_LOCK,
        { signal: controller.signal },
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
            setHeld(true);
          }),
      )
      .catch(() => {});
    return () => {
      controller.abort();
      release();
      setHeld(false);
    };
  }, [wanted]);
  useEffect(() => {
    dispatch({ type: "allow", allowed: held, at: Date.now() });
  }, [dispatch, held]);

  useEffect(() => {
    if (!held) return;
    const controller = new AbortController();
    const detector = new window.IdleDetector!();
    const report = () =>
      dispatch({
        type: "reading",
        reading: {
          idle: detector.userState === "idle",
          locked: detector.screenState === "locked",
        },
        at: Date.now(),
      });
    detector.addEventListener("change", report);
    detector
      .start({ threshold: AWAY_AFTER_MS, signal: controller.signal })
      .then(report, () => {
        // Revoked since it was read: the toggle shows off and the watch ends.
        if (!controller.signal.aborted) setPermission("denied");
      });
    return () => {
      controller.abort();
      detector.removeEventListener("change", report);
      // The next detector's first reading is a new baseline.
      dispatch({ type: "reading", reading: undefined, at: Date.now() });
    };
  }, [dispatch, held]);

  // A pause waiting to be sent again needs the beat too, after the toggle went off.
  const beating = ["arming", "watching", "pausing"].includes(phase.name);
  useEffect(() => {
    if (!beating) return;
    const interval = window.setInterval(
      () => dispatch({ type: "beat", at: Date.now() }),
      BEAT_MS,
    );
    return () => clearInterval(interval);
  }, [beating, dispatch]);

  function onChange(checked: boolean) {
    setRefused(false);
    if (!checked) return onEnabled?.(false);
    // Asked only from this click: the browser wants the click's activation.
    window.IdleDetector!.requestPermission().then(
      (answer) => {
        setPermission(answer);
        setRefused(answer !== "granted");
        onEnabled?.(answer === "granted");
      },
      () => {
        setRefused(true);
        onEnabled?.(false);
      },
    );
  }
  return {
    ...(supported &&
      onEnabled && {
        toggle: {
          checked: Boolean(enabled && permission === "granted"),
          refused,
          onChange,
        },
      }),
    // It stays while its answer is sent (App disables the buttons meanwhile), so nothing flickers.
    ...(phase.name === "asking" && {
      question: {
        minutes: awayMinutes(phase),
        keep: () => dispatch({ type: "answer", keep: true }),
        discard: () => dispatch({ type: "answer", keep: false }),
      },
    }),
  };
}
