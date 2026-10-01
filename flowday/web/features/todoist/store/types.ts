import type { Task } from "@/lib/types/task";
import type { SyncMode } from "../contracts";

export interface TodoistState {
  tasks: Task[];
  isLoading: boolean;
  isSyncing: boolean;
  lastSyncAt: string | null;
  /** A Todoist key is stored: the automatic sync runs only then. */
  hasApiKey: boolean;
  /** Earliest time (epoch ms) the server accepts another automatic sync; 0 = now. */
  nextAutoSyncAt: number;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  setTasks: (tasks: Task[]) => void;
  removeTask: (taskId: string) => void;
  deleteTask: (taskId: string) => Promise<void>;
  updateEstimate: (taskId: string, estimatedMins: number | null) => void;
  updateTitle: (taskId: string, title: string) => void;
  hydrate: () => Promise<void>;
  /** "manual" (the Sync buttons) by default; the page's automatic sync passes "auto". */
  sync: (mode?: SyncMode) => Promise<boolean>;
  addLocalTask: (title: string) => Promise<Task | null>;
}

export interface TaskSections {
  dueOnDate: Task[];
  overdue: Task[];
  quick: Task[];
}
