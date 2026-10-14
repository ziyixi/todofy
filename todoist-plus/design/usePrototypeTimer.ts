import { useEffect, useState } from "react";

export interface PrototypeTimerState {
  taskId: string;
  status: "running" | "paused";
  savedSeconds: number;
  startedAt: number;
}

export interface PrototypeStopwatch {
  timer: PrototypeTimerState | null;
  seconds: number;
  start: (taskId: string) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

function elapsed(timer: PrototypeTimerState): number {
  return (
    timer.savedSeconds +
    (timer.status === "running"
      ? Math.max(0, Math.floor((Date.now() - timer.startedAt) / 1000))
      : 0)
  );
}

export function formatPrototypeTime(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return [Math.floor(value / 3600), Math.floor(value / 60) % 60, value % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

/** Mount in the prototype shell so changing views preserves this local session. */
export function usePrototypeTimer(): PrototypeStopwatch {
  const [timer, setTimer] = useState<PrototypeTimerState | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    if (timer?.status !== "running") return;
    const interval = window.setInterval(() => tick((value) => value + 1), 1000);
    return () => window.clearInterval(interval);
  }, [timer?.status]);
  return {
    timer,
    seconds: timer ? elapsed(timer) : 0,
    start(taskId) {
      setTimer(
        (current) =>
          current ?? {
            taskId,
            status: "running",
            savedSeconds: 0,
            startedAt: Date.now(),
          },
      );
    },
    pause() {
      setTimer((current) =>
        current?.status === "running"
          ? { ...current, status: "paused", savedSeconds: elapsed(current) }
          : current,
      );
    },
    resume() {
      setTimer((current) =>
        current?.status === "paused"
          ? { ...current, status: "running", startedAt: Date.now() }
          : current,
      );
    },
    stop() {
      setTimer(null);
    },
  };
}
