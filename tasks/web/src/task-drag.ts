export const TASK_DRAG_TYPE = "application/x-todofy-task";

export type TaskDropTarget =
  { page: "project" | "label"; id: string } | { page: "inbox" | "today" };
