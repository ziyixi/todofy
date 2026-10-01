import type { Task } from "@/lib/types/task";

export interface TodoistState {
  tasks: Task[];
  isLoading: boolean;
  isSyncing: boolean;
  lastSyncAt: string | null;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  setTasks: (tasks: Task[]) => void;
  removeTask: (taskId: string) => void;
  deleteTask: (taskId: string) => Promise<void>;
  updateEstimate: (taskId: string, estimatedMins: number | null) => void;
  updateTitle: (taskId: string, title: string) => void;
  hydrate: () => Promise<void>;
  sync: () => Promise<void>;
  addLocalTask: (title: string) => Promise<Task | null>;
}

export interface TaskSections {
  dueOnDate: Task[];
  overdue: Task[];
  quick: Task[];
}
