"use client";

import { ChevronRight, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PRIORITY_CONFIG } from "@/lib/types/task";
import { formatDuration } from "@/lib/utils/time";
import { cn } from "@/lib/utils";
import type { Task } from "@/lib/types/task";

export function PlanningStepAddTasks({
  dueOnDateTasks,
  overdueTasks,
  flowCount,
  flowTaskIds,
  onAdd,
  onNext,
}: {
  dueOnDateTasks: Task[];
  overdueTasks: Task[];
  flowCount: number;
  flowTaskIds: Set<string>;
  onAdd: (id: string) => void;
  onNext: () => void;
}) {
  const available = [...overdueTasks, ...dueOnDateTasks];
  const unadded = available.filter((task) => !flowTaskIds.has(task.id));

  const handleAddAll = () => {
    for (const task of unadded) onAdd(task.id);
  };

  return (
    <div className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Add tasks to your day</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Pick from Todoist now, or finish setup and drag more tasks in later.
          </p>
        </div>
        {unadded.length >= 2 && (
          <Button
            data-testid="planning-add-all"
            size="sm"
            variant="outline"
            onClick={handleAddAll}
            className="shrink-0"
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add all ({unadded.length})
          </Button>
        )}
      </div>

      {available.length > 0 ? (
        <div className="mt-4 max-h-64 space-y-1.5 overflow-y-auto">
          {available.map((task) => {
            const priorityColor = PRIORITY_CONFIG[task.priority].color;
            return (
              <div
                key={task.id}
                data-testid={`planning-add-row-${task.id}`}
                className={cn(
                  "flex items-center gap-2.5 px-3 py-2",
                  flowTaskIds.has(task.id) ? "fd-muted-row opacity-65" : "fd-soft-row"
                )}
              >
                <span className={cn("h-2 w-2 shrink-0 rounded-full", priorityColor)} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-foreground">{task.title}</p>
                  {task.projectName && (
                    <p className="truncate text-[11px] text-muted-foreground">
                      {task.projectName}
                    </p>
                  )}
                </div>
                {task.estimatedMins != null && task.estimatedMins > 0 && (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatDuration(task.estimatedMins)}
                  </span>
                )}
                <button
                  data-testid={`planning-add-task-${task.id}`}
                  onClick={() => onAdd(task.id)}
                  className="fd-icon-button h-6 w-6 shrink-0 text-primary hover:bg-primary/10"
                  aria-label={`Add ${task.title}`}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-4 flex h-20 items-center justify-center rounded-md border border-dashed border-border/60 bg-background/35">
          <p className="text-xs text-muted-foreground/60">
            {flowCount > 0
              ? "All available tasks added to flow"
              : "No tasks available — sync Todoist first"}
          </p>
        </div>
      )}

      <div className="mt-4 flex items-center justify-between border-t border-border/55 pt-4">
        <span className="rounded-sm bg-background/45 px-2 py-1 text-xs text-muted-foreground">
          {flowCount} task{flowCount !== 1 ? "s" : ""} in flow
        </span>
        <Button size="sm" onClick={onNext}>
          Continue
          <ChevronRight className="ml-1 h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
