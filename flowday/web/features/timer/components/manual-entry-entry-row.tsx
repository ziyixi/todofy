"use client";

import { format } from "date-fns";
import { Pencil, Trash2 } from "lucide-react";
import type { TimeEntry } from "@/features/timer/contracts";
import { formatDurationShort, formatTimeRange } from "./manual-entry-utils";

export function ManualEntryRow({
  entry,
  onEdit,
  onDelete,
}: {
  entry: TimeEntry;
  onEdit: () => void;
  onDelete: () => void;
}) {
  async function handleDelete() {
    await fetch(`/api/entries/${entry.id}`, { method: "DELETE" });
    onDelete();
  }

  const entryDate = format(new Date(entry.startTime), "MMM d");

  return (
    <div
      data-testid="time-entry-row"
      data-entry-id={entry.id}
      className="group flex items-center justify-between rounded px-1.5 py-1 hover:bg-accent/50"
    >
      <div className="flex items-center gap-2 text-sm sm:text-xs">
        <span className="w-10 shrink-0 text-xs text-muted-foreground/60 sm:text-[10px]">
          {entryDate}
        </span>
        <span className="text-foreground">{formatTimeRange(entry.startTime, entry.endTime)}</span>
        {entry.durationS != null && entry.durationS > 0 && (
          <span className="text-muted-foreground">
            ({formatDurationShort(entry.durationS)})
          </span>
        )}
        <span className="text-xs uppercase text-muted-foreground/60 sm:text-[10px]">
          {entry.source}
        </span>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          onClick={onEdit}
          aria-label="Edit time entry"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground sm:h-5 sm:w-5"
        >
          <Pencil className="h-2.5 w-2.5" />
        </button>
        <button
          onClick={handleDelete}
          aria-label="Delete time entry"
          className="inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-red-600 sm:h-5 sm:w-5"
        >
          <Trash2 className="h-2.5 w-2.5" />
        </button>
      </div>
    </div>
  );
}
