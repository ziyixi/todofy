"use client";

import { useState } from "react";
import { format } from "date-fns";
import { useDraggable } from "@dnd-kit/react";
import { ChevronRight, Check, Zap } from "lucide-react";
import { useTaskSections } from "@/features/todoist/store";
import { useFlowStore, useFlowTasksForDate, useCompletedTasksForDate } from "@/features/flow/store";
import { PRIORITY_CONFIG } from "@/lib/types/task";
import { useLoggedSecondsByTaskForDate } from "@/lib/hooks/use-task-logged-seconds";
import { formatDuration, formatElapsed, formatLocalDate } from "@/lib/utils/time";
import {
  buildQuickTaskPlaceholder,
  isQuickTaskPlaceholderId,
  QUICK_TASK_PLACEHOLDER_ID,
} from "@/lib/utils/quick-task";
import { TaskCard } from "./task-card";
import { EstimateEditor } from "@/components/shared/estimate-editor";
import { cn } from "@/lib/utils";
import type { Task } from "@/lib/types/task";

export function TaskPool() {
  const currentDate = useFlowStore((s) => s.currentDate);
  const { dueOnDate, overdue, quick } = useTaskSections(currentDate);
  const arrangedTasks = useFlowTasksForDate(currentDate);
  const completedTasks = useCompletedTasksForDate(currentDate);
  const loggedByTask = useLoggedSecondsByTaskForDate(currentDate);
  const quickPlaceholderInFlow = [...arrangedTasks, ...completedTasks].some((task) =>
    isQuickTaskPlaceholderId(task.id)
  );
  const dateLabel =
    currentDate === formatLocalDate()
      ? "Today"
      : format(new Date(currentDate + "T00:00:00"), "EEE, MMM d");

  return (
    <div className="space-y-1.5">
      {arrangedTasks.length > 0 && (
        <TaskPoolSection
          title="Arranged"
          tasks={arrangedTasks}
          defaultOpen
          accentClass="text-primary"
          variant="arranged"
        />
      )}
      {completedTasks.length > 0 && (
        <TaskPoolSection
          title="Completed"
          tasks={completedTasks}
          defaultOpen={false}
          accentClass="text-green-500"
          variant="completed"
          loggedByTask={loggedByTask}
        />
      )}
      {quick.length > 0 && (
        <QuickTaskSection
          tasks={quick}
          placeholderInFlow={quickPlaceholderInFlow}
        />
      )}
      {overdue.length > 0 && (
        <TaskPoolSection
          title="Overdue"
          tasks={overdue}
          defaultOpen
          accentClass="text-destructive"
        />
      )}
      <TaskPoolSection title={dateLabel} tasks={dueOnDate} defaultOpen />
    </div>
  );
}

function QuickTaskSection({
  tasks,
  placeholderInFlow,
}: {
  tasks: Task[];
  placeholderInFlow: boolean;
}) {
  const [open, setOpen] = useState(true);
  const placeholder = buildQuickTaskPlaceholder(tasks);

  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 rounded-md px-1 py-1.5 text-sm font-semibold text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground sm:text-xs"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 transition-transform duration-150",
            open && "rotate-90"
          )}
        />
        <span className="flex-1 text-left text-muted-foreground">Quick</span>
        <span className="rounded-sm bg-background/70 px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {tasks.length}
        </span>
      </button>
      {!placeholderInFlow && (
        <div className="pb-1">
          <QuickPlaceholderCard task={placeholder} />
        </div>
      )}
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-150",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className={cn("min-h-0 overflow-hidden", !open && "hidden")}>
          <div className="space-y-1.5 pb-1">
            <div className="space-y-1">
              {tasks.map((task) => (
                <QuickTaskRow key={task.id} task={task} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function QuickPlaceholderCard({ task }: { task: Task }) {
  const { ref, isDragSource } = useDraggable({
    id: QUICK_TASK_PLACEHOLDER_ID,
    type: "task-pool-card",
    data: { task },
  });

  return (
    <div
      ref={ref}
      data-testid="task-pool-card"
      data-task-id={QUICK_TASK_PLACEHOLDER_ID}
      className={cn(
        "group flex cursor-grab items-start gap-2.5 rounded-md border border-dashed border-border/70 bg-muted/35 px-2.5 py-2 text-muted-foreground transition-colors hover:border-border hover:bg-accent/45 active:cursor-grabbing",
        isDragSource && "opacity-50"
      )}
    >
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm border border-border/60 bg-background/55">
        <Zap className="h-3 w-3" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground/75 sm:text-xs">
          {task.title}
        </p>
        {task.projectName && (
          <p className="truncate text-sm text-muted-foreground/70 sm:text-xs">
            {task.projectName}
          </p>
        )}
      </div>
      {task.estimatedMins != null && task.estimatedMins > 0 && (
        <span className="shrink-0 rounded-sm bg-background/60 px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground sm:text-[10px]">
          {formatDuration(task.estimatedMins)}
        </span>
      )}
    </div>
  );
}

function QuickTaskRow({ task }: { task: Task }) {
  return (
    <div
      data-testid="quick-task-row"
      data-task-id={task.id}
      className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-muted-foreground/70"
    >
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/35" />
      <p className="min-w-0 flex-1 truncate text-sm sm:text-xs">{task.title}</p>
      <EstimateEditor task={task} variant="inline" />
    </div>
  );
}

function TaskPoolSection({
  title,
  tasks,
  defaultOpen = false,
  accentClass,
  variant = "pool",
  loggedByTask = {},
}: {
  title: string;
  tasks: Task[];
  defaultOpen?: boolean;
  accentClass?: string;
  variant?: "pool" | "arranged" | "completed";
  loggedByTask?: Record<string, number>;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full items-center gap-1 rounded-md px-1 py-1.5 text-sm font-semibold text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground sm:text-xs"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 transition-transform duration-150",
            open && "rotate-90"
          )}
        />
        <span className={cn("flex-1 text-left", accentClass)}>{title}</span>
        <span
          className={cn(
            "rounded-sm bg-background/70 px-1.5 py-0.5 text-[10px] tabular-nums",
            accentClass
          )}
        >
          {tasks.length}
        </span>
      </button>
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-150",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className={cn("min-h-0 overflow-hidden", !open && "hidden")}>
          {tasks.length > 0 ? (
            <div className="space-y-1.5 pb-1">
              {variant === "pool"
                ? tasks.map((task) => <TaskCard key={task.id} task={task} />)
                : variant === "arranged"
                  ? tasks.map((task) => <ArrangedRow key={task.id} task={task} />)
                  : tasks.map((task) => (
                      <CompletedRow
                        key={task.id}
                        task={task}
                        loggedSeconds={loggedByTask[task.id] ?? 0}
                      />
                    ))}
            </div>
          ) : (
            <div className="mb-1 flex h-16 items-center justify-center rounded-md border border-dashed border-border/60 bg-background/35 text-sm text-muted-foreground/60 sm:text-xs">
              No tasks
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ArrangedRow({ task }: { task: Task }) {
  const priorityColor = PRIORITY_CONFIG[task.priority].color;

  return (
    <div className="fd-soft-row flex items-center gap-2 px-2.5 py-1.5">
      <span className={cn("h-2 w-2 shrink-0 rounded-full", priorityColor)} />
      <p className="flex-1 truncate text-sm font-medium text-foreground sm:text-xs">{task.title}</p>
      {task.estimatedMins != null && task.estimatedMins > 0 && (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground sm:text-[10px]">
          {formatDuration(task.estimatedMins)}
        </span>
      )}
    </div>
  );
}

function CompletedRow({ task, loggedSeconds }: { task: Task; loggedSeconds: number }) {
  return (
    <div className="flex items-center gap-2 rounded-md px-2.5 py-1.5 opacity-65">
      <Check className="h-3 w-3 shrink-0 text-green-500" />
      <p className="flex-1 truncate text-sm text-muted-foreground line-through sm:text-xs">{task.title}</p>
      <div className="flex items-center gap-1.5 shrink-0 text-xs tabular-nums text-muted-foreground/60 sm:text-[10px]">
        {task.estimatedMins != null && task.estimatedMins > 0 && (
          <span>{formatDuration(task.estimatedMins)}</span>
        )}
        {loggedSeconds > 0 && (
          <span>{formatElapsed(loggedSeconds)}</span>
        )}
      </div>
    </div>
  );
}
