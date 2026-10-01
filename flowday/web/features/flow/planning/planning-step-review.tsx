"use client";

import { ChevronRight, Minus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EstimateEditor } from "@/components/shared/estimate-editor";
import { PRIORITY_CONFIG } from "@/lib/types/task";
import { cn } from "@/lib/utils";
import type { Task } from "@/lib/types/task";

export function PlanningStepReview({
  tasks,
  onRemove,
  onNext,
  onBack,
}: {
  tasks: Task[];
  onRemove: (id: string) => void;
  onNext: () => void;
  onBack: () => void;
}) {
  return (
    <div className="p-5">
      <p className="text-sm font-medium text-foreground">Review your plan</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Adjust estimates or remove tasks. Drag-reordering stays available after setup.
      </p>

      {tasks.length > 0 ? (
        <div className="mt-4 max-h-64 space-y-1.5 overflow-y-auto">
          {tasks.map((task, index) => {
            const priorityColor = PRIORITY_CONFIG[task.priority].color;
            return (
              <div
                key={task.id}
                data-testid={`planning-review-row-${task.id}`}
                className="fd-soft-row flex items-center gap-2.5 px-3 py-2"
              >
                <span className="w-4 text-right text-xs tabular-nums text-muted-foreground/50">
                  {index + 1}
                </span>
                <span className={cn("h-2 w-2 shrink-0 rounded-full", priorityColor)} />
                <p className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {task.title}
                </p>
                <EstimateEditor task={task} variant="inline" />
                <button
                  onClick={() => onRemove(task.id)}
                  className="fd-icon-button h-6 w-6 shrink-0 hover:bg-red-500/15 hover:text-red-600"
                >
                  <Minus className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-4 flex h-20 items-center justify-center rounded-md border border-dashed border-border/60 bg-background/35">
          <p className="text-xs text-muted-foreground/60">No tasks in flow yet</p>
        </div>
      )}

      <div className="mt-4 flex items-center justify-end gap-2 border-t border-border/55 pt-4">
        <Button size="sm" variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button size="sm" onClick={onNext}>
          Continue
          <ChevronRight className="ml-1 h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
