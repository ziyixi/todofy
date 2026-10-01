"use client";

import { Check, ChevronsDown, Pause, Play, StickyNote, X } from "lucide-react";
import { PomodoroPicker } from "@/components/timer/pomodoro-picker";
import { ManualEntry } from "@/features/timer/components/manual-entry";
import { cn } from "@/lib/utils";

interface FlowTaskCardActionsProps {
  taskId: string;
  flowDate: string;
  estimatedMins: number | null;
  loggedSeconds: number;
  isActive: boolean;
  isRunning: boolean;
  showNote: boolean;
  hasNote: boolean;
  onToggleNote: () => void;
  onEntriesChanged: () => void;
  onPlayPause: () => void;
  onComplete: () => void;
  onSkip: () => void;
  onRemove: () => void;
  timingDisabled?: boolean;
  timingDisabledReason?: string;
}

export function FlowTaskCardActions({
  taskId,
  flowDate,
  estimatedMins,
  loggedSeconds,
  isActive,
  isRunning,
  showNote,
  hasNote,
  onToggleNote,
  onEntriesChanged,
  onPlayPause,
  onComplete,
  onSkip,
  onRemove,
  timingDisabled = false,
  timingDisabledReason,
}: FlowTaskCardActionsProps) {
  const timingTitle = timingDisabled
    ? timingDisabledReason
    : isRunning
      ? "Pause timer"
      : isActive
        ? "Resume timer"
        : "Start timer";

  return (
    <div className="flex items-center gap-0.5 rounded-md bg-background/28 p-0.5">
      <button
        className={cn(
          "fd-icon-button",
          "h-8 w-8 disabled:cursor-not-allowed disabled:opacity-45 sm:h-7 sm:w-7",
          isActive
            ? "text-primary hover:bg-primary/10"
            : "text-muted-foreground hover:bg-accent hover:text-foreground"
        )}
        onClick={onPlayPause}
        disabled={timingDisabled}
        title={timingTitle}
        aria-label={isRunning ? "Pause timer" : isActive ? "Resume timer" : "Start timer"}
      >
        {isRunning ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
      </button>
      <PomodoroPicker
        taskId={taskId}
        flowDate={flowDate}
        estimatedMins={estimatedMins}
        loggedMins={Math.floor(loggedSeconds / 60)}
        disabled={timingDisabled}
        disabledReason={timingDisabledReason}
      />
      <ManualEntry
        taskId={taskId}
        flowDate={flowDate}
        onEntriesChanged={onEntriesChanged}
        disabled={timingDisabled}
        disabledReason={timingDisabledReason}
      />
      <button
        className={cn(
          "fd-icon-button",
          "h-8 w-8 sm:h-7 sm:w-7",
          showNote || hasNote
            ? "text-primary hover:bg-primary/10"
            : "text-muted-foreground hover:bg-accent hover:text-foreground"
        )}
        onClick={onToggleNote}
        title="Toggle notes"
        aria-label="Toggle notes"
      >
        <StickyNote className="h-3.5 w-3.5" />
      </button>
      <button
        className="fd-icon-button h-8 w-8 hover:bg-chart-1/15 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45 sm:h-7 sm:w-7"
        onClick={onComplete}
        disabled={timingDisabled}
        title={timingDisabled ? timingDisabledReason : "Complete task"}
        aria-label="Complete task"
      >
        <Check className="h-3.5 w-3.5" />
      </button>
      <button
        className="fd-icon-button h-8 w-8 sm:h-7 sm:w-7"
        onClick={onSkip}
        aria-label="Skip task"
      >
        <ChevronsDown className="h-3.5 w-3.5" />
      </button>
      <button
        className="fd-icon-button h-8 w-8 hover:bg-red-500/15 hover:text-red-600 sm:h-7 sm:w-7"
        onClick={onRemove}
        title="Return to pool"
        aria-label="Return to pool"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
