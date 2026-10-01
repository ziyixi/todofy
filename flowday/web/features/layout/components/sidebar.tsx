"use client";

import { useState } from "react";
import { PanelLeftClose, PanelLeft, Search, RefreshCw, Pause, Play, Trash2 } from "lucide-react";
import { TooltipIconButton } from "@/components/ui/tooltip-icon-button";
import { cn } from "@/lib/utils";
import { useTodoistStore } from "@/features/todoist/store";
import { useTaskById } from "@/features/todoist/store";
import { useTimerStore } from "@/features/timer/store";
import { formatDuration, formatElapsed } from "@/lib/utils/time";
import { isMiscTaskId, MISC_TASK_TITLE } from "@/lib/utils/misc-task";
import { TaskPool } from "@/components/todoist/task-pool";
import { QuickAdd } from "@/components/todoist/quick-add";
import { DeletedTasksDialog } from "@/components/todoist/deleted-tasks-dialog";

function SidebarTimer() {
  const activeTaskId = useTimerStore((s) => s.activeTaskId);
  const status = useTimerStore((s) => s.status);
  const timerMode = useTimerStore((s) => s.timerMode);
  const pomodoroTargetSeconds = useTimerStore((s) => s.pomodoroTargetSeconds);
  const displaySeconds = useTimerStore((s) => s.displaySeconds);
  const pauseTimer = useTimerStore((s) => s.pauseTimer);
  const resumeTimer = useTimerStore((s) => s.resumeTimer);
  const task = useTaskById(activeTaskId ?? "");

  if (!activeTaskId || !task) return null;
  const isMiscTask = isMiscTaskId(activeTaskId);

  const isPomodoro = timerMode === "pomodoro";
  const pomodoroLabel =
    pomodoroTargetSeconds != null
      ? formatDuration(Math.round(pomodoroTargetSeconds / 60))
      : null;

  return (
    <div className="mx-3 mb-2 flex items-center gap-2 rounded-md border border-primary/20 bg-card/70 px-2.5 py-1.5 shadow-[0_1px_2px_oklch(0_0_0/0.025)]">
      <div className="relative flex h-2 w-2 shrink-0">
        {status === "running" && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/75" />
        )}
        <span
          className={cn(
            "relative inline-flex h-2 w-2 rounded-full",
            status === "running" ? "bg-primary" : "bg-muted-foreground"
          )}
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground sm:text-xs">
          {isMiscTask ? MISC_TASK_TITLE : task.title}
        </p>
        {isPomodoro && (
          <p className="truncate text-xs text-primary/80 sm:text-[10px]">
            Pomodoro{pomodoroLabel ? ` ${pomodoroLabel}` : ""}
          </p>
        )}
      </div>
      <span className="shrink-0 tabular-nums text-sm font-semibold text-primary sm:text-xs">
        {isPomodoro
          ? `${formatElapsed(displaySeconds)} left`
          : formatElapsed(displaySeconds)}
      </span>
      <button
        onClick={() => (status === "running" ? pauseTimer() : resumeTimer())}
        className="fd-icon-button h-6 w-6 shrink-0 sm:h-5 sm:w-5"
      >
        {status === "running" ? (
          <Pause className="h-3 w-3" />
        ) : (
          <Play className="h-3 w-3" />
        )}
      </button>
    </div>
  );
}

export function Sidebar({
  collapsed,
  onCollapsedChange,
}: {
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const [trashOpen, setTrashOpen] = useState(false);
  const searchQuery = useTodoistStore((s) => s.searchQuery);
  const setSearchQuery = useTodoistStore((s) => s.setSearchQuery);
  const isSyncing = useTodoistStore((s) => s.isSyncing);
  const sync = useTodoistStore((s) => s.sync);

  if (collapsed) {
    return (
      <>
        <div className="relative shrink-0">
          <TooltipIconButton
            className="absolute left-1 top-1 z-10 h-8 w-8 sm:h-7 sm:w-7"
            onClick={() => onCollapsedChange(false)}
            label="Expand sidebar"
            tooltipSide="right"
          >
            <PanelLeft className="h-4 w-4" />
          </TooltipIconButton>
        </div>

        <DeletedTasksDialog open={trashOpen} onOpenChange={setTrashOpen} />
      </>
    );
  }

  return (
    <>
      <aside
        className={cn(
          "fd-sidebar relative flex h-full w-[280px] shrink-0 flex-col"
        )}
      >
        {/* Sidebar header */}
        <div className="flex h-10 items-center justify-between px-3">
          <span className="fd-section-label">
            Todoist
          </span>
          <div className="flex items-center gap-0.5">
            <TooltipIconButton
              className="h-7 w-7 sm:h-6 sm:w-6"
              onClick={() => sync()}
              label="Sync tasks"
            >
              <RefreshCw className={cn("h-3 w-3", isSyncing && "animate-spin")} />
            </TooltipIconButton>
            <TooltipIconButton
              className="h-7 w-7 sm:h-6 sm:w-6"
              onClick={() => setTrashOpen(true)}
              label="Deleted tasks"
            >
              <Trash2 className="h-3 w-3" />
            </TooltipIconButton>
            <TooltipIconButton
              className="h-7 w-7 sm:h-6 sm:w-6"
              onClick={() => onCollapsedChange(true)}
              label="Collapse sidebar"
            >
              <PanelLeftClose className="h-3 w-3" />
            </TooltipIconButton>
          </div>
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <div className="fd-field flex h-8 items-center gap-2 px-2.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search tasks..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>

        {/* Quick add */}
        <div className="px-3 pb-2">
          <QuickAdd />
        </div>

        {/* Active timer indicator */}
        <SidebarTimer />

        {/* Task pool */}
        <div className="flex-1 overflow-y-auto px-3 py-1">
          <TaskPool />
        </div>
      </aside>

      <DeletedTasksDialog open={trashOpen} onOpenChange={setTrashOpen} />
    </>
  );
}
