"use client";

import { useEffect } from "react";
import { useTimerStore } from "@/features/timer/store";
import { useFlowStore } from "@/features/flow/store";
import { useTaskById } from "@/features/todoist/store";
import { usePopOutStore } from "@/lib/stores/pop-out-store";
import { formatDuration, formatElapsed } from "@/lib/utils/time";
import { isMiscTaskId, MISC_TASK_TITLE } from "@/lib/utils/misc-task";
import { Pause, Play, Check } from "lucide-react";

function useAppBadge() {
  const status = useTimerStore((s) => s.status);
  const displaySeconds = useTimerStore((s) => s.displaySeconds);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("setAppBadge" in navigator)) {
      return;
    }

    if (status === "idle") {
      void navigator.clearAppBadge?.();
      return;
    }

    const minutes = Math.max(Math.ceil(displaySeconds / 60), 1);
    void navigator.setAppBadge?.(minutes);
  }, [status, displaySeconds]);
}

function TimerContent() {
  const activeTaskId = useTimerStore((s) => s.activeTaskId);
  const activeFlowDate = useTimerStore((s) => s.activeFlowDate);
  const status = useTimerStore((s) => s.status);
  const timerMode = useTimerStore((s) => s.timerMode);
  const pomodoroTargetSeconds = useTimerStore((s) => s.pomodoroTargetSeconds);
  const displaySeconds = useTimerStore((s) => s.displaySeconds);
  const pauseTimer = useTimerStore((s) => s.pauseTimer);
  const resumeTimer = useTimerStore((s) => s.resumeTimer);
  const stopAndSave = useTimerStore((s) => s.stopAndSave);
  const closePopOut = usePopOutStore((s) => s.close);
  const completeTask = useFlowStore((s) => s.completeTask);
  const task = useTaskById(activeTaskId ?? "");

  if (!activeTaskId || !task) return null;
  const isMiscTask = isMiscTaskId(activeTaskId);

  const isPomodoro = timerMode === "pomodoro";
  const pomodoroLabel =
    pomodoroTargetSeconds != null
      ? formatDuration(Math.round(pomodoroTargetSeconds / 60))
      : null;

  const handleComplete = async () => {
    const date = activeFlowDate;
    const taskId = activeTaskId;
    await stopAndSave();
    if (isMiscTask) {
      closePopOut();
    } else if (date && taskId) {
      completeTask(taskId, date);
    }
  };

  return (
    <div className="fd-control-cluster flex h-8 items-center gap-2 px-2.5 py-1 sm:h-7">
      <div className="relative flex h-2 w-2">
        {status === "running" && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/75" />
        )}
        <span
          className={`relative inline-flex h-2 w-2 rounded-full ${
            status === "running" ? "bg-primary" : "bg-muted-foreground"
          }`}
        />
      </div>

      <span className="max-w-[120px] truncate text-sm font-medium text-foreground sm:text-xs">
        {isMiscTask ? MISC_TASK_TITLE : task.title}
      </span>

      {isPomodoro && (
        <span className="rounded-sm bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary sm:text-[10px]">
          Pomodoro{pomodoroLabel ? ` ${pomodoroLabel}` : ""}
        </span>
      )}

      <span className="tabular-nums text-sm font-semibold text-primary">
        {isPomodoro
          ? `${formatElapsed(displaySeconds)} left`
          : formatElapsed(displaySeconds)}
      </span>

      <div className="flex items-center gap-0.5">
        <button
          onClick={() => (status === "running" ? pauseTimer() : resumeTimer())}
          className="fd-icon-button h-7 w-7 sm:h-6 sm:w-6"
        >
          {status === "running" ? (
            <Pause className="h-3 w-3" />
          ) : (
            <Play className="h-3 w-3" />
          )}
        </button>
        <button
          onClick={handleComplete}
          aria-label={isMiscTask ? "Save misc time" : "Complete task"}
          title={isMiscTask ? "Save misc time" : "Complete task"}
          className="fd-icon-button h-7 w-7 hover:bg-chart-1/15 hover:text-foreground sm:h-6 sm:w-6"
        >
          <Check className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

export function TimerDisplay() {
  useAppBadge();
  const activeTaskId = useTimerStore((s) => s.activeTaskId);
  if (!activeTaskId) return null;
  return <TimerContent />;
}
