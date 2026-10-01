"use client";

import { useState, useMemo, useEffect } from "react";
import {
  format,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameDay,
  isSameMonth,
  addMonths,
  subMonths,
} from "date-fns";
import { ChevronLeft, ChevronRight, RotateCcw, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PRIORITY_CONFIG } from "@/lib/types/task";
import { useTodoistStore } from "@/features/todoist/store";
import type { Task } from "@/lib/types/task";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { fetchJsonNoStore } from "@/lib/client/http";
import { cn } from "@/lib/utils";

interface DeletedTasksDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function groupByDeletedDate(tasks: Task[]): Map<string, Task[]> {
  const map = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = task.deletedAt ? task.deletedAt.slice(0, 10) : "unknown";
    const list = map.get(key) ?? [];
    list.push(task);
    map.set(key, list);
  }
  return map;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function DeletedTasksDialog({
  open,
  onOpenChange,
}: DeletedTasksDialogProps) {
  const [allDeleted, setAllDeleted] = useState<Task[]>([]);
  const [viewMonth, setViewMonth] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const hydrate = useTodoistStore((s) => s.hydrate);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    fetchJsonNoStore<Task[]>("/api/tasks/deleted")
      .then((tasks) => {
        if (cancelled) return;
        const nextTasks = tasks ?? [];
        setAllDeleted(nextTasks);
        if (nextTasks.length > 0) {
          const sorted = [...nextTasks].sort((a, b) =>
            (b.deletedAt ?? "").localeCompare(a.deletedAt ?? "")
          );
          const mostRecent = sorted[0].deletedAt?.slice(0, 10) ?? null;
          setSelectedDate(mostRecent);
          if (mostRecent) {
            setViewMonth(new Date(mostRecent + "T00:00:00"));
          }
        } else {
          setSelectedDate(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAllDeleted([]);
          setSelectedDate(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const query = searchQuery.toLowerCase().trim();

  const filteredTasks = useMemo(() => {
    if (!query) return allDeleted;
    return allDeleted.filter(
      (t) =>
        t.title.toLowerCase().includes(query) ||
        (t.projectName && t.projectName.toLowerCase().includes(query))
    );
  }, [allDeleted, query]);

  const grouped = useMemo(() => groupByDeletedDate(filteredTasks), [filteredTasks]);

  // Calendar days for current view month
  const calendarDays = useMemo(() => {
    const monthStart = startOfMonth(viewMonth);
    const monthEnd = endOfMonth(viewMonth);
    const calStart = startOfWeek(monthStart);
    const calEnd = endOfWeek(monthEnd);
    return eachDayOfInterval({ start: calStart, end: calEnd });
  }, [viewMonth]);

  const today = new Date();

  // Tasks displayed in right panel
  const displayTasks = useMemo(() => {
    if (query) {
      // Search mode: show all matching tasks grouped by date
      return filteredTasks.sort((a, b) =>
        (b.deletedAt ?? "").localeCompare(a.deletedAt ?? "")
      );
    }
    if (selectedDate) {
      return grouped.get(selectedDate) ?? [];
    }
    return [];
  }, [query, filteredTasks, selectedDate, grouped]);

  const handleRestore = async (taskId: string) => {
    await fetch("/api/tasks/deleted", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId }),
    });
    setAllDeleted((prev) => prev.filter((t) => t.id !== taskId));
    await hydrate();
  };

  // Group displayTasks by date for search mode rendering
  const displayGrouped = useMemo(() => {
    if (!query) return null;
    const groups: Record<string, Task[]> = {};
    for (const t of displayTasks) {
      const key = t.deletedAt?.slice(0, 10) ?? "unknown";
      if (!groups[key]) groups[key] = [];
      groups[key].push(t);
    }
    return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
  }, [query, displayTasks]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Deleted Tasks</DialogTitle>
        </DialogHeader>

        <div className="flex gap-4" style={{ minHeight: 360 }}>
          {/* Left panel: search + calendar */}
          <div className="w-[240px] shrink-0 space-y-3">
            {/* Search */}
            <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2.5">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <input
                type="text"
                placeholder="Search deleted..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
              />
            </div>

            {/* Month navigation */}
            <div className="flex items-center justify-between">
              <button
                onClick={() => setViewMonth((m) => subMonths(m, 1))}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="text-sm font-medium text-foreground">
                {format(viewMonth, "MMMM yyyy")}
              </span>
              <button
                onClick={() => setViewMonth((m) => addMonths(m, 1))}
                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            {/* Calendar grid */}
            <div className="grid grid-cols-7 gap-0">
              {WEEKDAYS.map((d) => (
                <div
                  key={d}
                  className="pb-1 text-center text-[10px] font-medium text-muted-foreground"
                >
                  {d}
                </div>
              ))}
              {calendarDays.map((day) => {
                const dateKey = format(day, "yyyy-MM-dd");
                const isCurrentMonth = isSameMonth(day, viewMonth);
                const isToday = isSameDay(day, today);
                const isSelected = selectedDate === dateKey;
                const hasDeletedTasks = grouped.has(dateKey);

                return (
                  <button
                    key={dateKey}
                    onClick={() => {
                      setSelectedDate(dateKey);
                      setSearchQuery("");
                    }}
                    className={cn(
                      "relative flex h-8 w-full flex-col items-center justify-center rounded text-xs transition-colors",
                      !isCurrentMonth && "text-muted-foreground/40",
                      isCurrentMonth && "text-foreground",
                      isToday && "ring-1 ring-primary/30",
                      isSelected && "bg-primary text-primary-foreground",
                      !isSelected && "hover:bg-accent"
                    )}
                  >
                    {format(day, "d")}
                    {hasDeletedTasks && (
                      <span
                        className={cn(
                          "absolute bottom-0.5 h-1 w-1 rounded-full",
                          isSelected ? "bg-primary-foreground" : "bg-destructive"
                        )}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Right panel: task list */}
          <div className="flex-1 overflow-y-auto border-l border-border pl-4">
            <h3 className="mb-3 text-sm font-medium text-foreground">
              {query
                ? `Search results (${filteredTasks.length})`
                : selectedDate
                  ? format(new Date(selectedDate + "T00:00:00"), "MMM d, yyyy")
                  : "Select a date"}
            </h3>

            {displayTasks.length === 0 && (
              <p className="text-sm text-muted-foreground">
                {query
                  ? "No matching deleted tasks"
                  : selectedDate
                    ? "No deleted tasks on this date"
                    : "Click a date to view deleted tasks"}
              </p>
            )}

            {query && displayGrouped
              ? displayGrouped.map(([dateKey, tasks]) => (
                  <div key={dateKey} className="mb-4">
                    <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                      {format(new Date(dateKey + "T00:00:00"), "MMM d, yyyy")}
                    </p>
                    <div className="space-y-1">
                      {tasks.map((task) => (
                        <TaskRow
                          key={task.id}
                          task={task}
                          onRestore={handleRestore}
                        />
                      ))}
                    </div>
                  </div>
                ))
              : displayTasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    onRestore={handleRestore}
                  />
                ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TaskRow({
  task,
  onRestore,
}: {
  task: Task;
  onRestore: (id: string) => void;
}) {
  const priorityColor = PRIORITY_CONFIG[task.priority].color;

  return (
    <Tooltip>
      <TooltipTrigger render={<div />} className="w-full">
        <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent transition-colors">
          <span className={cn("h-2 w-2 shrink-0 rounded-full", priorityColor)} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm text-foreground">{task.title}</p>
            {task.projectName && (
              <p className="truncate text-xs text-muted-foreground">
                {task.projectName}
              </p>
            )}
          </div>
          <button
            onClick={() => onRestore(task.id)}
            className="shrink-0 opacity-0 group-hover:opacity-100 inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground transition-all"
            title="Restore task"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-sm">
        {task.title}
      </TooltipContent>
    </Tooltip>
  );
}
