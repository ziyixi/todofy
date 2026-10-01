import { create } from "zustand";
import { useFlowStore } from "@/features/flow/store/flow-store";
import { useTimerStore } from "@/features/timer/store/timer-store";
import { buildMiscTask } from "@/lib/utils/misc-task";
import {
  buildQuickTaskPlaceholder,
  getQuickTasksForDate,
  isQuickTask,
  isQuickTaskPlaceholderId,
} from "@/lib/utils/quick-task";
import { partitionTasksByDueDate } from "@/lib/utils/task-sections";
import type { Task } from "@/lib/types/task";
import type { TaskSections, TodoistState } from "./types";
import {
  createLocalTaskOnServer,
  deleteTaskOnServer,
  loadTasksAndSettings,
  persistTaskPatch,
  syncTasksOnServer,
} from "./persistence";

const EMPTY_IDS: string[] = [];

export const useTodoistStore = create<TodoistState>()((set, get) => ({
  tasks: [],
  isLoading: false,
  isSyncing: false,
  lastSyncAt: null,
  hasApiKey: false,
  nextAutoSyncAt: 0,
  searchQuery: "",

  setSearchQuery: (query) => set({ searchQuery: query }),
  setTasks: (tasks) => set({ tasks }),
  removeTask: (taskId) =>
    set((state) => ({ tasks: state.tasks.filter((task) => task.id !== taskId) })),

  deleteTask: async (taskId) => {
    set((state) => ({ tasks: state.tasks.filter((task) => task.id !== taskId) }));

    const flowState = useFlowStore.getState();
    for (const [date, ids] of Object.entries(flowState.flows)) {
      if (ids.includes(taskId)) {
        flowState.removeTask(taskId, date);
      }
    }
    for (const [date, ids] of Object.entries(flowState.completedTasks)) {
      if (ids.includes(taskId)) {
        flowState.removeCompletedTask(taskId, date);
      }
    }

    const timerState = useTimerStore.getState();
    if (timerState.activeTaskId === taskId) {
      timerState.stopWithoutSaving();
    }

    try {
      await deleteTaskOnServer(taskId);
    } catch {
      await Promise.all([get().hydrate(), useFlowStore.getState().hydrate()]);
    }
  },

  updateEstimate: (taskId, estimatedMins) => {
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === taskId ? { ...task, estimatedMins } : task
      ),
    }));
    persistTaskPatch({ taskId, estimatedMins }).catch(() => {
      void get().hydrate();
    });
  },

  updateTitle: (taskId, title) => {
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === taskId ? { ...task, title } : task
      ),
    }));
    persistTaskPatch({ taskId, title }).catch(() => {
      void get().hydrate();
    });
  },

  hydrate: async () => {
    set({ isLoading: true });
    try {
      const { tasks, settings } = await loadTasksAndSettings();
      if (tasks) {
        set({ tasks });
      }
      if (settings) {
        set({ lastSyncAt: settings.last_sync_at, hasApiKey: settings.has_api_key });
      }
    } catch {
      // Hydration failures leave the current cache intact until the next sync succeeds.
    } finally {
      set({ isLoading: false });
    }
  },

  sync: async (mode = "manual") => {
    if (get().isSyncing) return false;
    set({ isSyncing: true });
    try {
      const before = get().lastSyncAt;
      const data = await syncTasksOnServer(mode);
      set({ lastSyncAt: data.lastSyncAt, nextAutoSyncAt: data.nextAutoSyncAt });
      // Reload the task list only when something changed here, or another tab or device synced meanwhile.
      if (data.changed > 0 || data.fullSync || data.lastSyncAt !== before) {
        await get().hydrate();
      }
      return true;
    } catch {
      // A manual sync's failure is on the banner; the automatic one retries at its next turn. The task list
      // stays usable with the last loaded state.
      return false;
    } finally {
      set({ isSyncing: false });
    }
  },

  addLocalTask: async (title) => {
    try {
      const task = await createLocalTaskOnServer(title);
      if (!task) return null;
      set((state) => ({ tasks: [...state.tasks, task] }));
      return task;
    } catch {
      return null;
    }
  },
}));

export function useTaskSections(date?: string): TaskSections {
  const tasks = useTodoistStore((state) => state.tasks);
  const searchQuery = useTodoistStore((state) => state.searchQuery);
  const currentDate = useFlowStore((state) => state.currentDate);
  const targetDate = date ?? currentDate;
  const flowTaskIds = useFlowStore((state) => state.flows[targetDate] ?? EMPTY_IDS);
  const completedTaskIds = useFlowStore(
    (state) => state.completedTasks[targetDate] ?? EMPTY_IDS
  );
  const allCompletedTasks = useFlowStore((state) => state.completedTasks);

  const query = searchQuery.toLowerCase().trim();
  const inFlow = new Set([...flowTaskIds, ...completedTaskIds]);
  const completedLocalTaskIds = new Set(
    Object.values(allCompletedTasks).flat()
  );

  const filtered = tasks.filter((task) => {
    if (task.deletedAt) return false;
    if (task.isCompleted) return false;
    if (!task.todoistId && completedLocalTaskIds.has(task.id)) return false;
    if (inFlow.has(task.id)) return false;
    if (!query) return true;
    return (
      task.title.toLowerCase().includes(query) ||
      (task.projectName && task.projectName.toLowerCase().includes(query)) ||
      task.labels.some((label) => label.toLowerCase().includes(query))
    );
  });

  const ordinaryTasks = filtered.filter((task) => !isQuickTask(task));
  const quick = getQuickTasksForDate(filtered, targetDate);
  return { ...partitionTasksByDueDate(ordinaryTasks, targetDate), quick };
}

export function useTaskById(id: string): Task | undefined {
  const task = useTodoistStore((state) =>
    state.tasks.find((candidate) => candidate.id === id)
  );
  if (isQuickTaskPlaceholderId(id)) return buildQuickTaskPlaceholder();
  return task ?? buildMiscTask(id) ?? undefined;
}

export function useQuickTasksForDate(date: string): Task[] {
  const tasks = useTodoistStore((state) => state.tasks);
  const allCompletedTasks = useFlowStore((state) => state.completedTasks);
  const completedOnDate = new Set(allCompletedTasks[date] ?? []);
  const completedLocalTaskIds = new Set(
    Object.values(allCompletedTasks).flat()
  );
  return getQuickTasksForDate(
    tasks.filter((task) => {
      if (completedOnDate.has(task.id)) return false;
      return task.todoistId || !completedLocalTaskIds.has(task.id);
    }),
    date
  );
}
