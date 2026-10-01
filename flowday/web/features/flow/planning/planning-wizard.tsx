"use client";

import { useState } from "react";
import { Sunrise, X } from "lucide-react";
import { useFlowStore, useFlowTasksForDate } from "@/features/flow/store";
import { useTaskSections } from "@/features/todoist/store";
import { PlanningStepAddTasks } from "./planning-step-add-tasks";
import { PlanningStepReview } from "./planning-step-review";
import { PlanningStepConfirm } from "./planning-step-confirm";
import {
  PLANNING_STEPS,
  PlanningStepIndicator,
} from "./planning-step-indicator";

interface PlanningWizardProps {
  date: string;
  onDismiss: () => void;
  onComplete: () => void;
}

export function PlanningWizard({
  date,
  onDismiss,
  onComplete,
}: PlanningWizardProps) {
  const setPlanningCompleted = useFlowStore((state) => state.setPlanningCompleted);
  const addTask = useFlowStore((state) => state.addTask);
  const removeTask = useFlowStore((state) => state.removeTask);
  const flowTasks = useFlowTasksForDate(date);
  const { dueOnDate, overdue } = useTaskSections(date);
  const capacityMins = useFlowStore((state) => state.dayCapacityMins);

  const [stepIndex, setStepIndex] = useState(0);
  const currentStep = PLANNING_STEPS[stepIndex];

  const handleDismiss = () => {
    setPlanningCompleted(date);
    onDismiss();
  };

  const handleComplete = () => {
    setPlanningCompleted(date);
    onComplete();
  };

  const estimatedTotalMins = flowTasks.reduce(
    (sum, task) => sum + (task.estimatedMins ?? 0),
    0
  );
  const overCapacity = capacityMins > 0 && estimatedTotalMins > capacityMins;

  return (
    <div className="flex flex-1 flex-col items-center justify-center p-6">
      <div className="w-full max-w-lg">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-md border border-amber-500/25 bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <Sunrise className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-lg font-semibold text-foreground">Start Your Day</h2>
              <p className="text-xs text-muted-foreground">Build a focused queue for today.</p>
            </div>
          </div>
          <button
            onClick={handleDismiss}
            aria-label="Dismiss planning wizard"
            title="Dismiss planning wizard"
            className="fd-icon-button h-7 w-7"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <PlanningStepIndicator stepIndex={stepIndex} />

        <div className="fd-dialog-panel overflow-hidden rounded-md border border-border/75">
          {currentStep.id === "add" && (
            <PlanningStepAddTasks
              dueOnDateTasks={dueOnDate}
              overdueTasks={overdue}
              flowCount={flowTasks.length}
              flowTaskIds={new Set(flowTasks.map((task) => task.id))}
              onAdd={(id) => addTask(id, date)}
              onNext={() => setStepIndex((index) => Math.min(index + 1, PLANNING_STEPS.length - 1))}
            />
          )}
          {currentStep.id === "review" && (
            <PlanningStepReview
              tasks={flowTasks}
              onRemove={(id) => removeTask(id, date)}
              onBack={() => setStepIndex((index) => Math.max(index - 1, 0))}
              onNext={() => setStepIndex((index) => Math.min(index + 1, PLANNING_STEPS.length - 1))}
            />
          )}
          {currentStep.id === "confirm" && (
            <PlanningStepConfirm
              taskCount={flowTasks.length}
              estimatedMins={estimatedTotalMins}
              capacityMins={capacityMins}
              overCapacity={overCapacity}
              onBack={() => setStepIndex((index) => Math.max(index - 1, 0))}
              onConfirm={handleComplete}
            />
          )}
        </div>
      </div>
    </div>
  );
}
