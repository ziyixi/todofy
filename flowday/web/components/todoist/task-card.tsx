"use client";

import { useDraggable } from "@dnd-kit/react";
import { Trash2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Task } from "@/lib/types/task";
import { PRIORITY_CONFIG } from "@/lib/types/task";
import { useTodoistStore } from "@/features/todoist/store";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { EstimateEditor } from "@/components/shared/estimate-editor";
import { EditableLocalTitle } from "@/components/shared/editable-local-title";
import { cn } from "@/lib/utils";

export function TaskCard({ task }: { task: Task }) {
  const { ref, isDragSource } = useDraggable({
    id: task.id,
    type: "task-pool-card",
    data: { task },
  });
  const deleteTask = useTodoistStore((s) => s.deleteTask);
  const updateTitle = useTodoistStore((s) => s.updateTitle);

  const priorityColor = PRIORITY_CONFIG[task.priority].color;
  const hasDescription = task.description && task.description.trim().length > 0;
  const hasLabels = task.labels.length > 0;
  const hasTooltipContent = hasDescription || hasLabels;

  const cardContent = (
    <>
      <span
        className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", priorityColor)}
      />
      <div className="min-w-0 flex-1">
        <EditableLocalTitle
          title={task.title}
          isLocal={!task.todoistId}
          onCommit={(title) => updateTitle(task.id, title)}
        />
        {task.projectName && (
          <p className="truncate text-sm text-muted-foreground sm:text-xs">
            {task.projectName}
          </p>
        )}
      </div>
      <EstimateEditor task={task} variant="inline" />
      <button
        onClick={(e) => { e.stopPropagation(); deleteTask(task.id); }}
        className="fd-icon-button h-6 w-6 shrink-0 opacity-0 transition-all hover:text-red-500 group-hover:opacity-100 sm:h-5 sm:w-5"
        title="Delete task"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </>
  );

  const cardClassName = cn(
    "group flex cursor-grab items-start gap-2.5 rounded-md border border-border/75 bg-card/78 px-2.5 py-2 shadow-[0_1px_2px_oklch(0_0_0/0.025)] transition-colors hover:border-border hover:bg-accent/70 active:cursor-grabbing",
    isDragSource && "opacity-50"
  );

    if (!hasTooltipContent) {
      return (
      <div ref={ref} data-testid="task-pool-card" data-task-id={task.id} className={cardClassName}>
        {cardContent}
      </div>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger render={<div />} className="w-full">
        <div ref={ref} data-testid="task-pool-card" data-task-id={task.id} className={cardClassName}>
          {cardContent}
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs">
        <div className="space-y-1.5">
          {hasLabels && (
            <div className="flex flex-wrap gap-1">
              {task.labels.map((label) => (
                <span
                  key={label}
                  className="rounded-full bg-background/20 px-1.5 py-0.5 text-xs sm:text-[10px]"
                >
                  {label}
                </span>
              ))}
            </div>
          )}
          {hasDescription && (
            <div className="text-sm leading-relaxed sm:text-xs [&_p]:my-0.5 [&_ul]:ml-3 [&_ul]:list-disc [&_ol]:ml-3 [&_ol]:list-decimal [&_a]:underline [&_strong]:font-semibold [&_code]:rounded [&_code]:bg-background/20 [&_code]:px-1 [&_code]:text-[11px] [&_h1]:text-sm [&_h1]:font-bold [&_h2]:text-xs [&_h2]:font-bold [&_h3]:text-xs [&_h3]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:border-background/30 [&_blockquote]:pl-2 [&_blockquote]:italic">
              <ReactMarkdown>{task.description!}</ReactMarkdown>
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
