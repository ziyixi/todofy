import type { ComponentProps } from "react";
import { isSortable } from "@dnd-kit/react/sortable";
import { DragDropProvider } from "@dnd-kit/react";
import { useFlowStore } from "@/features/flow/store";
import type { Task } from "@/lib/types/task";

type DragEndEvent = Parameters<
  NonNullable<ComponentProps<typeof DragDropProvider>["onDragEnd"]>
>[0];

export function handleAppDragEnd(event: DragEndEvent) {
  if (event.canceled) return;

  const { source, target } = event.operation;
  if (!source) return;

  if (isSortable(source)) {
    const { initialIndex, index } = source;
    const date = (source.data as { date?: string })?.date;
    if (date && initialIndex !== index) {
      useFlowStore.getState().reorderTasks(initialIndex, index, date);
    }
    return;
  }

  if (!target) return;

  const task = source.data?.task as Task | undefined;
  if (!task) return;

  let targetDate: string | undefined;
  let insertIndex: number | undefined;

  if (isSortable(target)) {
    targetDate = (target.data as { date?: string })?.date;
    insertIndex = target.index as number;
  } else {
    targetDate = (target.data as { date?: string })?.date;
  }

  if (targetDate) {
    useFlowStore.getState().addTask(task.id, targetDate, insertIndex);
  }
}
