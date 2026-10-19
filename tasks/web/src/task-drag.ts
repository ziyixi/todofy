import type { Task } from "./api";

export type TaskDropTarget =
  { page: "project" | "label"; id: string } | { page: "inbox" | "today" };

export type TaskDropPosition = "before" | "inside" | "after";
export type TaskRowDrop = {
  kind: "row";
  task: Task;
  position: TaskDropPosition;
  peers: readonly Task[];
};
export type TaskDrop =
  | TaskRowDrop
  | { kind: "category"; target: TaskDropTarget }
  | { kind: "detach" };
