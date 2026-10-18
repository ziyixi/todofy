import type { Task } from "./api";

/** The supplied siblings are already in custom order, as returned by ListTasks. */
export function taskDropOrder(
  siblings: readonly Task[],
  movingId: string,
  targetId: string,
  after = false,
): number | undefined {
  if (movingId === targetId) return;
  const remaining = siblings.filter((task) => task.id !== movingId);
  const target = remaining.findIndex((task) => task.id === targetId);
  if (target < 0) return;
  const position = target + Number(after);
  const previous = remaining[position - 1];
  const next = remaining[position];
  if (previous && next)
    return ((previous.sortOrder ?? 0) + (next.sortOrder ?? 0)) / 2;
  return next ? (next.sortOrder ?? 0) - 1 : (previous!.sortOrder ?? 0) + 1;
}
