"use client";

import { useState, useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { useFlowTasksForDate, useCompletedTasksForDate, useFlowStore } from "@/features/flow/store";
import { fetchJsonNoStore } from "@/lib/client/http";
import { formatDuration, formatElapsed } from "@/lib/utils/time";
import {
  sumEntryDurationSeconds,
  type DurationEntryLike,
} from "@/lib/utils/time-entries";
import { useTimerStore } from "@/features/timer/store";
import { cn } from "@/lib/utils";

export function ProgressBar({ date }: { date: string }) {
  const flowTasks = useFlowTasksForDate(date);
  const completedTasks = useCompletedTasksForDate(date);
  const completedCount = completedTasks.length;
  const totalCount = flowTasks.length + completedCount;
  const capacityMins = useFlowStore((s) => s.dayCapacityMins);

  const estimatedTotalMins = [...flowTasks, ...completedTasks].reduce(
    (sum, t) => sum + (t.estimatedMins ?? 0),
    0
  );
  const remainingMins = flowTasks.reduce(
    (sum, t) => sum + (t.estimatedMins ?? 0),
    0
  );

  // Fetch actual logged time for this date
  const [actualSeconds, setActualSeconds] = useState(0);
  const entryRevision = useTimerStore((s) => s.entryRevision);
  useEffect(() => {
    let cancelled = false;
    fetchJsonNoStore<DurationEntryLike[]>(
      `/api/entries?date=${encodeURIComponent(date)}`
    )
      .then((entries) => {
        if (!cancelled) {
          setActualSeconds(sumEntryDurationSeconds(entries));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [date, completedCount, entryRevision]);

  if (totalCount === 0) return null;

  const fraction = totalCount > 0 ? completedCount / totalCount : 0;
  const overCapacity = capacityMins > 0 && estimatedTotalMins > capacityMins;

  return (
    <div className="border-t border-border bg-background/80 px-4 py-2.5 backdrop-blur-sm">
      {overCapacity && (
        <div className="mb-1.5 flex items-center gap-1.5 text-sm text-amber-600 dark:text-amber-400 sm:text-xs">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>
            You&apos;ve planned ~{formatDuration(estimatedTotalMins)} for a{" "}
            {formatDuration(capacityMins)} day
          </span>
        </div>
      )}
      <div className="flex items-center justify-between text-sm text-muted-foreground sm:text-xs">
        <span>
          {completedCount}/{totalCount} tasks
        </span>
        <div className="flex items-center gap-3">
          {actualSeconds > 0 && (
            <span className="tabular-nums font-medium text-foreground">
              {formatElapsed(actualSeconds)} logged
            </span>
          )}
          {estimatedTotalMins > 0 && (
            <span className="tabular-nums">~{formatDuration(estimatedTotalMins)} est</span>
          )}
          {capacityMins > 0 && (
            <span className="tabular-nums text-muted-foreground/60">
              / {formatDuration(capacityMins)} cap
            </span>
          )}
          {remainingMins > 0 && (
            <span className="tabular-nums">~{formatDuration(remainingMins)} left</span>
          )}
        </div>
      </div>
      <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full bg-gradient-to-r from-primary to-primary/70 transition-all duration-300",
            fraction > 0 && "shadow-[0_0_8px_-2px_var(--color-primary)]"
          )}
          style={{ width: `${Math.round(fraction * 100)}%` }}
        />
      </div>
    </div>
  );
}
