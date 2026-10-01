"use client";

import { useCompletedTasksForDate, useFlowTasksForDate } from "@/features/flow/store";
import { ReadOnlyDayFlow } from "./read-only-day-flow";
import { EditableDayFlow } from "./editable-day-flow";

interface DayFlowProps {
  date: string;
  readOnly?: boolean;
}

export function DayFlow({ date, readOnly = false }: DayFlowProps) {
  const flowTasks = useFlowTasksForDate(date);
  const completedTasks = useCompletedTasksForDate(date);
  const isEmpty = flowTasks.length === 0 && completedTasks.length === 0;

  if (readOnly) {
    return (
      <ReadOnlyDayFlow
        flowTasks={flowTasks}
        completedTasks={completedTasks}
        date={date}
      />
    );
  }

  return (
    <EditableDayFlow
      flowTasks={flowTasks}
      completedTasks={completedTasks}
      date={date}
      isEmpty={isEmpty}
    />
  );
}
