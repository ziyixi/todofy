"use client";

import { useState } from "react";
import { Hourglass, Play } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useTimerStore } from "@/features/timer/store";
import { usePopOutStore } from "@/lib/stores/pop-out-store";
import { buildPomodoroPresets } from "@/lib/utils/pomodoro-presets";
import { cn } from "@/lib/utils";

interface PomodoroPickerProps {
  taskId: string;
  flowDate: string;
  estimatedMins?: number | null;
  loggedMins?: number | null;
  disabled?: boolean;
  disabledReason?: string;
}

export function PomodoroPicker({
  taskId,
  flowDate,
  estimatedMins,
  loggedMins,
  disabled = false,
  disabledReason,
}: PomodoroPickerProps) {
  const [open, setOpen] = useState(false);
  const [customMins, setCustomMins] = useState("");
  const startPomodoro = useTimerStore((s) => s.startPomodoro);
  const activeTaskId = useTimerStore((s) => s.activeTaskId);
  const timerMode = useTimerStore((s) => s.timerMode);
  const pomodoroTargetSeconds = useTimerStore((s) => s.pomodoroTargetSeconds);
  const openPopOut = usePopOutStore((s) => s.open);

  const isActivePomodoro = activeTaskId === taskId && timerMode === "pomodoro";
  const presets = buildPomodoroPresets(estimatedMins, loggedMins);

  const launch = (mins: number) => {
    if (disabled) return;
    if (!Number.isFinite(mins) || mins <= 0) return;
    void openPopOut();
    void startPomodoro(taskId, flowDate, mins * 60);
    setOpen(false);
    setCustomMins("");
  };

  const submitCustom = () => {
    const mins = Number.parseInt(customMins, 10);
    if (!Number.isFinite(mins) || mins <= 0) return;
    launch(mins);
  };

  return (
    <Popover
      open={!disabled && open}
      onOpenChange={(next) => {
        if (disabled) {
          setOpen(false);
          return;
        }
        setOpen(next);
        if (!next) setCustomMins("");
      }}
    >
      <PopoverTrigger
        render={<button />}
        onClick={(e) => e.stopPropagation()}
        disabled={disabled}
        className={cn(
          "fd-icon-button h-8 w-8 sm:h-7 sm:w-7",
          disabled
            ? "cursor-not-allowed opacity-45"
            : isActivePomodoro
            ? "text-primary hover:bg-primary/10"
            : "text-muted-foreground hover:bg-accent hover:text-foreground"
        )}
        title={disabled ? disabledReason : "Start Pomodoro"}
        aria-label="Start Pomodoro"
      >
        <Hourglass className="h-3.5 w-3.5" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-auto p-2"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-2 px-1 text-xs font-medium text-muted-foreground">
          Pomodoro
        </p>
        <div className="grid grid-cols-2 gap-1">
          {presets.map((preset) => {
            const selected =
              isActivePomodoro && pomodoroTargetSeconds === preset.mins * 60;
            return (
              <button
                key={preset.mins}
                data-testid="pomodoro-preset"
                data-mins={preset.mins}
                data-suggested={preset.suggested ? "true" : undefined}
                onClick={() => launch(preset.mins)}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                  selected
                    ? "bg-primary text-primary-foreground"
                    : preset.suggested
                      ? "bg-primary/15 text-primary ring-1 ring-primary/30 hover:bg-primary/25"
                      : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
                title={preset.suggested ? "Matches remaining estimate" : undefined}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <form
          className="mt-2 flex items-center gap-1 border-t border-border/50 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            submitCustom();
          }}
        >
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={600}
            value={customMins}
            onChange={(e) => setCustomMins(e.target.value)}
            placeholder="Custom"
            data-testid="pomodoro-custom-input"
            aria-label="Custom Pomodoro minutes"
            className="w-16 rounded-md border border-border bg-background px-1.5 py-1 text-xs text-foreground outline-none focus:ring-1 focus:ring-primary/40 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />
          <span className="text-xs text-muted-foreground">min</span>
          <button
            type="submit"
            data-testid="pomodoro-custom-start"
            disabled={!customMins || Number.parseInt(customMins, 10) <= 0}
            className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground"
            title="Start custom Pomodoro"
          >
            <Play className="h-3 w-3" />
          </button>
        </form>
      </PopoverContent>
    </Popover>
  );
}
