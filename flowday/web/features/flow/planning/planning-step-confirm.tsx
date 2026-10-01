"use client";

import { AlertTriangle, Sunrise } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDuration } from "@/lib/utils/time";
import { cn } from "@/lib/utils";

export function PlanningStepConfirm({
  taskCount,
  estimatedMins,
  capacityMins,
  overCapacity,
  onConfirm,
  onBack,
}: {
  taskCount: number;
  estimatedMins: number;
  capacityMins: number;
  overCapacity: boolean;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const fraction = capacityMins > 0 ? Math.min(estimatedMins / capacityMins, 1) : 0;

  return (
    <div className="p-5">
      <p className="text-sm font-medium text-foreground">You&apos;re all set!</p>
      <div className="mt-4 space-y-3 rounded-md border border-border/65 bg-background/35 p-3">
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-muted-foreground">Tasks</span>
          <span className="font-medium text-foreground">{taskCount}</span>
        </div>
        <div className="flex items-baseline justify-between text-sm">
          <span className="text-muted-foreground">Estimated time</span>
          <span className="font-medium tabular-nums text-foreground">
            {estimatedMins > 0 ? `~${formatDuration(estimatedMins)}` : "—"}
          </span>
        </div>
        {capacityMins > 0 && (
          <>
            <div className="flex items-baseline justify-between text-sm">
              <span className="text-muted-foreground">Day capacity</span>
              <span className="tabular-nums text-muted-foreground">
                {formatDuration(capacityMins)}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted/80">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-300",
                  overCapacity ? "bg-amber-500" : "bg-primary"
                )}
                style={{ width: `${Math.round(fraction * 100)}%` }}
              />
            </div>
          </>
        )}
        {overCapacity && (
          <div className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <span>
              You&apos;ve planned ~{formatDuration(estimatedMins)} for a{" "}
              {formatDuration(capacityMins)} day
            </span>
          </div>
        )}
        {!overCapacity && estimatedMins > 0 && capacityMins > 0 && (
          <p className="text-xs text-green-600 dark:text-green-400">
            Looks good — you have room in your day.
          </p>
        )}
      </div>

      <div className="mt-5 flex items-center justify-end gap-2 border-t border-border/55 pt-4">
        <Button size="sm" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button size="sm" onClick={onConfirm}>
          <Sunrise className="mr-1.5 h-3.5 w-3.5" />
          Start My Day
        </Button>
      </div>
    </div>
  );
}
