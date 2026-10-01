"use client";

import { useCallback, useState } from "react";
import { Clock, Plus } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { TimeEntry } from "@/features/timer/contracts";
import { fetchJsonNoStore } from "@/lib/client/http";
import { sumEntryDurationSeconds } from "@/lib/utils/time-entries";
import { formatDurationShort } from "./manual-entry-utils";
import { AddEntryDialog, EditEntryDialog } from "./manual-entry-dialogs";
import { ManualEntryRow } from "./manual-entry-entry-row";

export function ManualEntry({
  taskId,
  flowDate,
  onEntriesChanged,
  disabled = false,
  disabledReason,
}: {
  taskId: string;
  flowDate: string;
  onEntriesChanged?: () => void;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<TimeEntry | null>(null);
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const fetchEntries = useCallback(async () => {
    try {
      const nextEntries = await fetchJsonNoStore<TimeEntry[]>(
        `/api/entries?taskId=${encodeURIComponent(taskId)}`
      );
      if (nextEntries) {
        setEntries(nextEntries);
      }
    } catch {
      // Keeping the popover open with stale data is less disruptive than closing it.
    }
  }, [taskId]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (disabled) {
      setIsOpen(false);
      return;
    }
    if (nextOpen) void fetchEntries();
    setIsOpen(nextOpen);
  };

  const handleChanged = useCallback(() => {
    void fetchEntries();
    onEntriesChanged?.();
  }, [fetchEntries, onEntriesChanged]);

  const totalSeconds = sumEntryDurationSeconds(entries);

  return (
    <>
      <Popover open={!disabled && isOpen} onOpenChange={handleOpenChange}>
        <PopoverTrigger
          className="fd-icon-button relative h-8 w-8 disabled:cursor-not-allowed disabled:opacity-45 sm:h-7 sm:w-7"
          title={disabled ? disabledReason : "Time entries"}
          aria-label="Time entries"
          disabled={disabled}
        >
          <Clock className="h-3.5 w-3.5" />
          {entries.length > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary text-[8px] font-bold text-primary-foreground">
              {entries.length}
            </span>
          )}
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80">
          <div className="space-y-1">
            <div className="flex items-center justify-between px-1.5">
              <h4 className="text-sm font-medium text-muted-foreground sm:text-xs">
                Time Entries
              </h4>
              {totalSeconds > 0 && (
                <span className="text-sm font-medium tabular-nums text-primary sm:text-xs">
                  Total: {formatDurationShort(totalSeconds)}
                </span>
              )}
            </div>

            {entries.length === 0 && (
              <p className="px-1.5 py-1 text-sm text-muted-foreground/60 sm:text-xs">
                No entries yet
              </p>
            )}

            <div className="max-h-48 overflow-y-auto">
              {entries.map((entry) => (
                <ManualEntryRow
                  key={entry.id}
                  entry={entry}
                  onEdit={() => setEditingEntry(entry)}
                  onDelete={handleChanged}
                />
              ))}
            </div>

            <button
              onClick={() => setAddDialogOpen(true)}
              className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground sm:text-xs"
            >
              <Plus className="h-3 w-3" />
              Add time entry
            </button>
          </div>
        </PopoverContent>
      </Popover>

      {editingEntry && (
        <EditEntryDialog
          entry={editingEntry}
          open={Boolean(editingEntry)}
          onOpenChange={(open) => {
            if (!open) setEditingEntry(null);
          }}
          onSaved={handleChanged}
        />
      )}

      <AddEntryDialog
        taskId={taskId}
        flowDate={flowDate}
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onCreated={handleChanged}
      />
    </>
  );
}
