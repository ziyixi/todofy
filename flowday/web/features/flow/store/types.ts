export type ViewMode = 1 | 3 | 5;

export interface FlowState {
  currentDate: string;
  viewMode: ViewMode;
  flows: Record<string, string[]>;
  completedTasks: Record<string, string[]>;
  // Monotonic counter to generate unique sortable ids (prevents stale dnd-kit state on re-add).
  sortableGen: number;
  // Maps taskId -> generation number for unique sortable ids.
  sortableKeys: Record<string, number>;
  // Maps flow date -> selected quick task id for the synthetic Quick block.
  quickFocusTaskIds: Record<string, string>;
  setCurrentDate: (date: string) => void;
  setViewMode: (mode: ViewMode) => void;
  setQuickFocusTask: (date: string, taskId: string | null) => void;
  addTask: (taskId: string, date: string, index?: number) => void;
  removeTask: (taskId: string, date: string) => void;
  reorderTasks: (fromIndex: number, toIndex: number, date: string) => void;
  completeTask: (taskId: string, date: string) => void;
  uncompleteTask: (taskId: string, date: string) => void;
  removeCompletedTask: (taskId: string, date: string) => void;
  skipTask: (taskId: string, date: string) => void;
  rolloverTasks: (fromDate: string, toDate: string) => Promise<void>;
  rolloverSelectedTasks: (
    fromDate: string,
    toDate: string,
    taskIds: string[]
  ) => Promise<void>;
  dayCapacityMins: number;
  setDayCapacityMins: (mins: number) => void;
  hydrated: boolean;
  planningCompletedDates: Record<string, boolean>;
  setPlanningCompleted: (date: string) => void;
  hydrate: () => Promise<void>;
}
