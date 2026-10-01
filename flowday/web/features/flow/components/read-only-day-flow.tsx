"use client";

import { Check, StickyNote } from "lucide-react";
import { PRIORITY_CONFIG } from "@/lib/types/task";
import { formatDuration } from "@/lib/utils/time";
import { cn } from "@/lib/utils";
import type { Task } from "@/lib/types/task";
import { useDayNotesMap } from "../hooks/use-day-flow-data";
import { ProgressBar } from "./progress-bar";

export function ReadOnlyDayFlow({
  flowTasks,
  completedTasks,
  date,
}: {
  flowTasks: Task[];
  completedTasks: Task[];
  date: string;
}) {
  const notesByTask = useDayNotesMap(date);

  if (flowTasks.length === 0 && completedTasks.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground/60 sm:text-xs">No tasks</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-2 py-2">
        <div className="space-y-1.5">
          {flowTasks.map((task, index) => (
            <ReadOnlyTaskRow
              key={task.id}
              task={task}
              isNext={index === 0}
              noteText={notesByTask[task.id] ?? ""}
            />
          ))}
        </div>
        {completedTasks.length > 0 && (
          <div className="mt-3">
            <p className="mb-1 text-xs font-medium text-muted-foreground sm:text-[10px]">
              Done ({completedTasks.length})
            </p>
            <div className="space-y-1">
              {completedTasks.map((task) => (
                <ReadOnlyCompletedRow
                  key={task.id}
                  task={task}
                  noteText={notesByTask[task.id] ?? ""}
                />
              ))}
            </div>
          </div>
        )}
      </div>
      <ProgressBar date={date} />
    </div>
  );
}

function ReadOnlyTaskRow({
  task,
  isNext,
  noteText,
}: {
  task: Task;
  isNext: boolean;
  noteText: string;
}) {
  const priorityColor = PRIORITY_CONFIG[task.priority].color;

  return (
    <div
      data-testid="read-only-flow-task-row"
      data-task-id={task.id}
      className={cn(
        "flex flex-col gap-1 rounded-md border bg-card px-2.5 py-1.5 shadow-[0_1px_2px_oklch(0_0_0/0.04)]",
        isNext
          ? "border-b-border border-l-4 border-l-primary border-r-border border-t-border"
          : "border-border"
      )}
    >
      <div className="flex items-start gap-2">
        <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", priorityColor)} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground sm:text-xs">
            {task.title}
          </p>
          {task.estimatedMins != null && task.estimatedMins > 0 && (
            <p className="text-xs tabular-nums text-muted-foreground sm:text-[10px]">
              {formatDuration(task.estimatedMins)}
            </p>
          )}
        </div>
        {noteText && <StickyNote className="mt-1 h-2.5 w-2.5 shrink-0 text-primary/50" />}
      </div>
      {noteText && (
        <p className="ml-4 truncate text-xs text-muted-foreground/70 sm:text-[10px]">
          {noteText}
        </p>
      )}
    </div>
  );
}

function ReadOnlyCompletedRow({
  task,
  noteText,
}: {
  task: Task;
  noteText: string;
}) {
  return (
    <div
      data-testid="read-only-completed-task-row"
      data-task-id={task.id}
      className="rounded-md bg-muted/30 px-2.5 py-1"
    >
      <div className="flex items-center gap-2">
        <Check className="h-2.5 w-2.5 shrink-0 text-green-500" />
        <p className="truncate text-sm text-muted-foreground line-through decoration-muted-foreground/40 sm:text-[11px]">
          {task.title}
        </p>
        {noteText && <StickyNote className="h-2.5 w-2.5 shrink-0 text-primary/40" />}
      </div>
      {noteText && (
        <p className="ml-4 truncate text-xs text-muted-foreground/60 sm:text-[10px]">
          {noteText}
        </p>
      )}
    </div>
  );
}
