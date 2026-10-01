export interface DurationEntryLike {
  durationS?: number | null;
}

export interface TaskDurationEntryLike extends DurationEntryLike {
  taskId: string;
}

export function entryDurationSeconds(entry: DurationEntryLike): number {
  return entry.durationS ?? 0;
}

export function sumEntryDurationSeconds(
  entries: readonly DurationEntryLike[] | null | undefined
): number {
  if (!entries?.length) return 0;
  return entries.reduce((sum, entry) => sum + entryDurationSeconds(entry), 0);
}

export function mapEntrySecondsByTask(
  entries: readonly TaskDurationEntryLike[] | null | undefined
): Record<string, number> {
  if (!entries?.length) return {};

  const secondsByTask: Record<string, number> = {};
  for (const entry of entries) {
    secondsByTask[entry.taskId] =
      (secondsByTask[entry.taskId] ?? 0) + entryDurationSeconds(entry);
  }
  return secondsByTask;
}
