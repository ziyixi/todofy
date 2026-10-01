"use client";

import { useRef, useState } from "react";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { formatDuration } from "@/lib/utils/time";
import { useTodoistStore } from "@/features/todoist/store";
import type { Task } from "@/lib/types/task";
import { cn } from "@/lib/utils";

const PRESETS = [
  { label: "30m", mins: 30 },
  { label: "45m", mins: 45 },
  { label: "1h", mins: 60 },
  { label: "1.5h", mins: 90 },
  { label: "2h", mins: 120 },
  { label: "2.5h", mins: 150 },
  { label: "3h", mins: 180 },
];

interface EstimateEditorProps {
  task: Task;
  variant: "inline" | "flow";
}

export function EstimateEditor({ task, variant }: EstimateEditorProps) {
  const [open, setOpen] = useState(false);
  const [customValue, setCustomValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Tracks whether the close path was driven by an explicit commit (preset
  // click, Clear, Enter, or Escape). Without this, the auto-flush below would
  // fight preset clicks (blur saves the typed value before the click lands)
  // and would also undo a deliberate Escape cancel.
  const committedRef = useRef(false);
  const updateEstimate = useTodoistStore((s) => s.updateEstimate);

  const commit = (mins: number | null) => {
    committedRef.current = true;
    if (mins !== task.estimatedMins) {
      updateEstimate(task.id, mins);
    }
    setOpen(false);
  };

  const commitCustom = () => {
    const trimmed = customValue.trim();
    if (trimmed === "") {
      commit(null);
      return;
    }
    const mins = parseInt(trimmed, 10);
    if (isNaN(mins) || mins < 0) {
      committedRef.current = true;
      setOpen(false);
      return;
    }
    commit(mins);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setCustomValue(task.estimatedMins?.toString() ?? "");
      committedRef.current = false;
    } else if (!committedRef.current) {
      // Closed by clicking outside — flush the typed value so the user
      // doesn't have to remember to press Enter to save it.
      commitCustom();
    }
    setOpen(nextOpen);
  };

  const displayText =
    task.estimatedMins != null && task.estimatedMins > 0
      ? variant === "flow"
        ? `${formatDuration(task.estimatedMins)} est`
        : formatDuration(task.estimatedMins)
      : variant === "flow"
        ? "— est"
        : "—";

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={<button />}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "cursor-pointer rounded-sm px-1 py-0.5 tabular-nums transition-colors hover:bg-accent/55 hover:text-foreground",
          variant === "inline" && "mt-0.5 shrink-0 text-xs text-muted-foreground",
          variant === "flow" && "text-muted-foreground"
        )}
        title="Click to edit estimate"
      >
        {displayText}
      </PopoverTrigger>
      <PopoverContent
        side={variant === "inline" ? "bottom" : "top"}
        align="start"
        className="w-auto p-2"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="grid grid-cols-4 gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.mins}
              onClick={() => commit(p.mins)}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                task.estimatedMins === p.mins
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {p.label}
            </button>
          ))}
          <button
            onClick={() => commit(null)}
            className="rounded-md px-2.5 py-1.5 text-xs font-medium bg-muted text-muted-foreground hover:bg-red-500/20 hover:text-red-600 transition-colors"
          >
            Clear
          </button>
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          <input
            ref={inputRef}
            data-testid="estimate-custom-input"
            type="number"
            min="0"
            value={customValue}
            onChange={(e) => setCustomValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitCustom();
              if (e.key === "Escape") {
                committedRef.current = true;
                setOpen(false);
              }
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-16 rounded border border-border bg-background px-2 py-1 text-xs tabular-nums text-foreground outline-none focus:ring-1 focus:ring-primary"
            placeholder="mins"
          />
          <span className="text-[10px] text-muted-foreground">min</span>
        </div>
      </PopoverContent>
    </Popover>
  );
}
