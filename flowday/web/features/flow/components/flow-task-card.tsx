"use client";

import { useCallback, useState } from "react";
import { useSortable } from "@dnd-kit/react/sortable";
import { ChevronRight, Zap } from "lucide-react";
import type { Task } from "@/lib/types/task";
import { PRIORITY_CONFIG } from "@/lib/types/task";
import { formatDuration, formatElapsed } from "@/lib/utils/time";
import { derivePomodoroLoggedSeconds } from "@/lib/utils/pomodoro-progress";
import { useFlowStore } from "@/features/flow/store";
import { useQuickTasksForDate, useTodoistStore } from "@/features/todoist/store";
import { useTimerStore } from "@/features/timer/store";
import { useTaskLoggedSeconds } from "@/lib/hooks/use-task-logged-seconds";
import { EstimateEditor } from "@/components/shared/estimate-editor";
import { EditableLocalTitle } from "@/components/shared/editable-local-title";
import { cn } from "@/lib/utils";
import { isQuickTaskPlaceholderId } from "@/lib/utils/quick-task";
import { useTaskNote } from "../hooks/use-task-note";
import { FlowTaskCardActions } from "./flow-task-card-actions";

interface FlowTaskCardProps {
  task: Task;
  index: number;
  isNext: boolean;
  date: string;
}

export function FlowTaskCard({ task, index, isNext, date }: FlowTaskCardProps) {
  const completeTask = useFlowStore((state) => state.completeTask);
  const skipTask = useFlowStore((state) => state.skipTask);
  const removeTask = useFlowStore((state) => state.removeTask);
  const sortableKey = useFlowStore((state) => state.sortableKeys[task.id] ?? 0);
  const quickFocusTaskId = useFlowStore((state) => state.quickFocusTaskIds[date]);
  const setQuickFocusTask = useFlowStore((state) => state.setQuickFocusTask);
  const updateTitle = useTodoistStore((state) => state.updateTitle);

  const activeTaskId = useTimerStore((state) => state.activeTaskId);
  const timerStatus = useTimerStore((state) => state.status);
  const displaySeconds = useTimerStore((state) => state.displaySeconds);
  const timerMode = useTimerStore((state) => state.timerMode);
  const pomodoroTargetSeconds = useTimerStore((state) => state.pomodoroTargetSeconds);
  const priorSeconds = useTimerStore((state) => state.priorSeconds);
  const startTimer = useTimerStore((state) => state.startTimer);
  const pauseTimer = useTimerStore((state) => state.pauseTimer);
  const resumeTimer = useTimerStore((state) => state.resumeTimer);
  const stopAndSave = useTimerStore((state) => state.stopAndSave);
  const stopWithoutSaving = useTimerStore((state) => state.stopWithoutSaving);
  const entryRevision = useTimerStore((state) => state.entryRevision);

  const isQuickPlaceholder = isQuickTaskPlaceholderId(task.id);
  const quickTasks = useQuickTasksForDate(date);
  const activeQuickTask = isQuickPlaceholder
    ? quickTasks.find((candidate) => candidate.id === activeTaskId)
    : null;
  const selectedQuickTask = isQuickPlaceholder
    ? quickTasks.find((candidate) => candidate.id === quickFocusTaskId)
    : null;
  const focusedQuickTask = activeQuickTask ?? selectedQuickTask ?? null;
  const actionTask = isQuickPlaceholder ? focusedQuickTask : task;
  const actionTaskId = actionTask?.id ?? null;
  const timingDisabled = isQuickPlaceholder && !actionTaskId;
  const timingDisabledReason = "Select a quick task first";
  const isActive = actionTaskId != null && activeTaskId === actionTaskId;
  const isRunning = isActive && timerStatus === "running";
  const isPaused = isActive && timerStatus === "paused";

  const [localRevision, setLocalRevision] = useState(0);
  const onEntriesChanged = useCallback(() => {
    setLocalRevision((revision) => revision + 1);
  }, []);
  const combinedRevision = localRevision + entryRevision;

  const loggedSeconds = useTaskLoggedSeconds(actionTaskId ?? "", combinedRevision);
  const shownSeconds = isActive ? displaySeconds : loggedSeconds;
  const isActivePomodoro = isActive && timerMode === "pomodoro";
  const activePomodoroLoggedSeconds =
    isActivePomodoro && pomodoroTargetSeconds != null
      ? derivePomodoroLoggedSeconds(priorSeconds, pomodoroTargetSeconds, displaySeconds)
      : null;

  const noteTaskId = actionTaskId ?? task.id;
  const { note, showNote, hasNote, updateNote, toggle: toggleNote } = useTaskNote(
    noteTaskId,
    date
  );

  const { ref, isDragSource, isDropTarget } = useSortable({
    id: `${date}::${task.id}::${sortableKey}`,
    index,
    group: `day-flow-${date}`,
    type: "flow-task",
    accept: ["task-pool-card", "flow-task"],
    data: { task, date },
  });

  const priorityColor = PRIORITY_CONFIG[task.priority].color;

  const handlePlayPause = () => {
    if (!actionTaskId) return;
    if (isRunning) {
      void pauseTimer();
    } else if (isPaused) {
      resumeTimer();
    } else {
      void startTimer(actionTaskId, date);
    }
  };

  const handleComplete = async () => {
    if (!actionTaskId) return;
    if (isActive) {
      await stopAndSave();
    }
    completeTask(actionTaskId, date);
    if (isQuickPlaceholder && quickTasks.length <= 1) {
      removeTask(task.id, date);
    }
  };

  const handleRemove = () => {
    if (isActive) {
      stopWithoutSaving();
    }
    removeTask(task.id, date);
  };

  return (
    <div
      ref={ref}
      data-testid="flow-task-card"
      data-task-id={task.id}
      className={cn("relative cursor-grab active:cursor-grabbing", isDragSource && "opacity-50")}
    >
      <div
        className={cn(
          "pointer-events-none absolute -top-1.5 left-0 right-0 h-0.5 rounded-full transition-all duration-150",
          isDropTarget
            ? "scale-x-100 bg-primary opacity-100"
            : "scale-x-0 bg-transparent opacity-0"
        )}
      />

      <div
        className={cn(
          "fd-flow-card group rounded-md border px-4 py-3 transition-all",
          isQuickPlaceholder
            ? "border-dashed border-border/70 bg-muted/35 shadow-none"
            : isNext
              ? "fd-flow-card-focus border-b-border border-l-4 border-r-border border-t-border"
              : "border-border",
          isActive &&
            "fd-flow-card-focus border-l-4",
          isDropTarget && !isDragSource && "border-primary/40"
        )}
      >
        <div className="flex items-start gap-3">
          {isQuickPlaceholder ? (
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-sm border border-border/60 bg-background/50 text-muted-foreground">
              <Zap className="h-3.5 w-3.5" />
            </span>
          ) : (
            <span className={cn("mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full", priorityColor)} />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {isNext && !isQuickPlaceholder && (
                <span className="fd-focus-pill shrink-0 rounded-sm px-1.5 py-0.5 text-xs font-semibold sm:text-[10px]">
                  Next
                </span>
              )}
              {isQuickPlaceholder ? (
                <p className="truncate text-sm font-semibold text-foreground/80">
                  {task.title}
                </p>
              ) : (
                <EditableLocalTitle
                  title={task.title}
                  isLocal={!task.todoistId}
                  onCommit={(title) => updateTitle(task.id, title)}
                />
              )}
            </div>
            {task.projectName && (
              <p className="mt-0.5 truncate text-sm text-muted-foreground sm:text-xs">
                {task.projectName}
              </p>
            )}
            {isQuickPlaceholder ? (
              <QuickTaskSelector
                tasks={quickTasks}
                selectedTaskId={focusedQuickTask?.id ?? null}
                activeTaskId={activeTaskId}
                onSelect={(taskId) => setQuickFocusTask(date, taskId)}
              />
            ) : task.labels.length > 0 ? (
              <div className="mt-1 flex flex-wrap gap-1">
                {task.labels.map((label) => (
                  <span
                    key={label}
                    className="rounded-sm border border-border/55 bg-muted/65 px-1.5 py-0.5 text-xs text-muted-foreground sm:text-[10px]"
                  >
                    {label}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3 text-sm text-muted-foreground sm:text-xs">
            {isQuickPlaceholder ? (
              <div className="flex min-w-0 items-center gap-2">
                {task.estimatedMins != null && task.estimatedMins > 0 ? (
                  <span className="shrink-0 tabular-nums text-muted-foreground/75">
                    {formatDuration(task.estimatedMins)} quick total
                  </span>
                ) : (
                  <span className="shrink-0 text-muted-foreground/60">Quick tasks</span>
                )}
              </div>
            ) : (
              <EstimateEditor task={task} variant="flow" />
            )}
            {shownSeconds > 0 ? (
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    "tabular-nums font-medium",
                    isActive ? "fd-focus-text" : "text-foreground"
                  )}
                >
                  {isActivePomodoro
                    ? `${formatElapsed(shownSeconds)} left`
                    : formatElapsed(shownSeconds)}
                </span>
                {isActivePomodoro &&
                  activePomodoroLoggedSeconds != null &&
                  activePomodoroLoggedSeconds > 0 && (
                    <span className="tabular-nums text-muted-foreground">
                      {formatElapsed(activePomodoroLoggedSeconds)} logged
                    </span>
                  )}
              </div>
            ) : (
              <span className="tabular-nums text-muted-foreground/60">&mdash;</span>
            )}
          </div>

          <FlowTaskCardActions
            taskId={actionTaskId ?? task.id}
            flowDate={date}
            estimatedMins={actionTask?.estimatedMins ?? task.estimatedMins}
            loggedSeconds={loggedSeconds}
            isActive={isActive}
            isRunning={isRunning}
            showNote={showNote}
            hasNote={hasNote}
            onToggleNote={toggleNote}
            onEntriesChanged={onEntriesChanged}
            onPlayPause={handlePlayPause}
            onComplete={() => void handleComplete()}
            onSkip={() => skipTask(task.id, date)}
            onRemove={handleRemove}
            timingDisabled={timingDisabled}
            timingDisabledReason={timingDisabledReason}
          />
        </div>

        {showNote && (
          <div className="mt-2 border-t border-border/50 pt-2">
            <textarea
              value={note}
              onChange={(event) => updateNote(event.target.value)}
              onMouseDown={(event) => event.stopPropagation()}
              placeholder="Jot notes while working…"
              className="w-full resize-none rounded-md bg-muted/50 px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/40 focus:ring-1 focus:ring-primary/30 sm:text-xs"
              rows={2}
            />
          </div>
        )}
      </div>
    </div>
  );
}

function QuickTaskSelector({
  tasks,
  selectedTaskId,
  activeTaskId,
  onSelect,
}: {
  tasks: Task[];
  selectedTaskId: string | null;
  activeTaskId: string | null;
  onSelect: (taskId: string) => void;
}) {
  const [open, setOpen] = useState(false);

  if (tasks.length === 0) {
    return (
      <p className="mt-1.5 text-xs text-muted-foreground/60 sm:text-[10px]">
        No quick tasks left.
      </p>
    );
  }

  return (
    <div className="mt-2">
      <button
        type="button"
        data-testid="quick-focus-list-toggle"
        aria-expanded={open}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        className="flex w-full items-center gap-1.5 rounded-md border border-border/45 bg-background/45 px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground sm:text-[10px]"
      >
        <ChevronRight
          className={cn(
            "h-3 w-3 shrink-0 transition-transform duration-150",
            open && "rotate-90"
          )}
        />
        <span className="min-w-0 flex-1 truncate">
          {selectedTaskId
            ? tasks.find((task) => task.id === selectedTaskId)?.title ?? "Quick tasks"
            : "Quick tasks"}
        </span>
        <span className="shrink-0 tabular-nums text-muted-foreground/70">
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
          <div className="mt-1 grid gap-1">
            {tasks.map((task) => {
              const selected = selectedTaskId === task.id;
              const active = activeTaskId === task.id;
              return (
                <div
                  key={task.id}
                  data-testid="quick-focus-option"
                  data-task-id={task.id}
                  onPointerDown={(event) => event.stopPropagation()}
                  className={cn(
                    "flex min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors sm:text-[10px]",
                    selected
                      ? "border-primary/35 bg-primary/10 text-foreground"
                      : "border-border/45 bg-background/45 text-muted-foreground"
                  )}
                >
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelect(task.id);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left transition-colors hover:text-foreground"
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        active
                          ? "bg-chart-1"
                          : selected
                            ? "bg-primary"
                            : "bg-muted-foreground/35"
                      )}
                    />
                    <span className="min-w-0 flex-1 truncate">{task.title}</span>
                  </button>
                  <EstimateEditor task={task} variant="inline" />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
