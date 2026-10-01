export type TaskPriority = 1 | 2 | 3 | 4;

export interface Task {
  id: string;
  todoistId: string | null;
  title: string;
  description: string | null;
  projectName: string | null;
  projectColor: string | null;
  priority: TaskPriority;
  labels: string[];
  estimatedMins: number | null;
  isCompleted: boolean;
  completedAt: string | null;
  dueDate: string | null;
  createdAt: string;
  deletedAt: string | null;
}

// Todoist convention: 4 = urgent (red), 3 = high (orange), 2 = medium (yellow), 1 = normal (blue)
export const PRIORITY_CONFIG: Record<
  TaskPriority,
  { color: string; label: string }
> = {
  4: { color: "bg-red-500", label: "Urgent" },
  3: { color: "bg-orange-500", label: "High" },
  2: { color: "bg-yellow-500", label: "Medium" },
  1: { color: "bg-blue-500", label: "Normal" },
};
