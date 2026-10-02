import { create } from "zustand";
import { useTodoistStore } from "@/features/todoist/store/todoist-store";
import type { Task } from "@/lib/types/task";
import {
  buildQuickTaskPlaceholder,
  getQuickTasksForDate,
  isQuickTaskPlaceholderId,
} from "@/lib/utils/quick-task";
import type { FlowState } from "./types";
import {
  loadFlowState,
  loadHydrationData,
  persistCompleted,
  persistFlow,
  persistPlanningCompleted,
  sendRollover,
  todayStr,
} from "./persistence";

function flowForDate(state: FlowState, date: string): string[] {
  return state.flows[date] ?? [];
}

function completedForDate(state: FlowState, date: string): string[] {
  return state.completedTasks[date] ?? [];
}

function clearQuickFocusForDate(
  focusTaskIds: Record<string, string>,
  date: string
): Record<string, string> {
  if (!(date in focusTaskIds)) return focusTaskIds;
  const next = { ...focusTaskIds };
  delete next[date];
  return next;
}

function quickTaskCandidatesForDate(
  tasks: Task[],
  completedTasks: Record<string, string[]>,
  date: string
): Task[] {
  const completedOnDate = new Set(completedTasks[date] ?? []);
  const completedLocalTaskIds = new Set(Object.values(completedTasks).flat());

  return tasks.filter((task) => {
    if (completedOnDate.has(task.id)) return false;
    return task.todoistId || !completedLocalTaskIds.has(task.id);
  });
}

function recoverFlowState() {
  void useFlowStore.getState().hydrate();
}

export const useFlowStore = create<FlowState>()((set) => ({
  currentDate: todayStr(),
  viewMode: 1,
  flows: {},
  completedTasks: {},
  sortableGen: 0,
  sortableKeys: {},
  quickFocusTaskIds: {},
  dayCapacityMins: 360,
  hydrated: false,
  planningCompletedDates: {},

  setCurrentDate: (date) => set({ currentDate: date }),
  setViewMode: (mode) => set({ viewMode: mode }),
  setQuickFocusTask: (date, taskId) =>
    set((state) => ({
      quickFocusTaskIds:
        taskId == null
          ? clearQuickFocusForDate(state.quickFocusTaskIds, date)
          : { ...state.quickFocusTaskIds, [date]: taskId },
    })),
  setDayCapacityMins: (mins) => set({ dayCapacityMins: mins }),

  setPlanningCompleted: (date) => {
    set((state) => ({
      planningCompletedDates: { ...state.planningCompletedDates, [date]: true },
    }));
    persistPlanningCompleted(date);
  },

  addTask: (taskId, date, index) =>
    set((state) => {
      const flow = flowForDate(state, date);
      if (flow.includes(taskId)) return state;
      const ids = [...flow];
      if (index != null) {
        ids.splice(index, 0, taskId);
      } else {
        ids.push(taskId);
      }
      const nextGen = state.sortableGen + 1;
      persistFlow(date, ids, recoverFlowState);
      return {
        flows: { ...state.flows, [date]: ids },
        sortableGen: nextGen,
        sortableKeys: { ...state.sortableKeys, [taskId]: nextGen },
      };
    }),

  removeTask: (taskId, date) =>
    set((state) => {
      const ids = flowForDate(state, date).filter((id) => id !== taskId);
      persistFlow(date, ids, recoverFlowState);
      return {
        flows: { ...state.flows, [date]: ids },
        quickFocusTaskIds:
          isQuickTaskPlaceholderId(taskId) ||
          state.quickFocusTaskIds[date] === taskId
            ? clearQuickFocusForDate(state.quickFocusTaskIds, date)
            : state.quickFocusTaskIds,
      };
    }),

  reorderTasks: (fromIndex, toIndex, date) =>
    set((state) => {
      const ids = [...flowForDate(state, date)];
      const [removed] = ids.splice(fromIndex, 1);
      ids.splice(toIndex, 0, removed);
      persistFlow(date, ids, recoverFlowState);
      return { flows: { ...state.flows, [date]: ids } };
    }),

  completeTask: (taskId, date) =>
    set((state) => {
      const flowIds = flowForDate(state, date).filter((id) => id !== taskId);
      persistFlow(date, flowIds, recoverFlowState);
      persistCompleted(date, taskId, true, recoverFlowState);
      return {
        flows: { ...state.flows, [date]: flowIds },
        completedTasks: {
          ...state.completedTasks,
          [date]: [...completedForDate(state, date), taskId],
        },
        quickFocusTaskIds:
          isQuickTaskPlaceholderId(taskId) ||
          state.quickFocusTaskIds[date] === taskId
            ? clearQuickFocusForDate(state.quickFocusTaskIds, date)
            : state.quickFocusTaskIds,
      };
    }),

  uncompleteTask: (taskId, date) =>
    set((state) => {
      const flowIds = [...flowForDate(state, date), taskId];
      persistFlow(date, flowIds, recoverFlowState);
      persistCompleted(date, taskId, false, recoverFlowState);
      return {
        flows: { ...state.flows, [date]: flowIds },
        completedTasks: {
          ...state.completedTasks,
          [date]: completedForDate(state, date).filter((id) => id !== taskId),
        },
      };
    }),

  removeCompletedTask: (taskId, date) =>
    set((state) => {
      persistCompleted(date, taskId, false, recoverFlowState);
      return {
        completedTasks: {
          ...state.completedTasks,
          [date]: completedForDate(state, date).filter((id) => id !== taskId),
        },
      };
    }),

  skipTask: (taskId, date) =>
    set((state) => {
      const ids = flowForDate(state, date).filter((id) => id !== taskId);
      ids.push(taskId);
      persistFlow(date, ids, recoverFlowState);
      return { flows: { ...state.flows, [date]: ids } };
    }),

  rolloverTasks: async (fromDate, toDate) => {
    try {
      await sendRollover(fromDate, toDate);
    } catch {
      // Shown on the banner; the reload below shows what the server has.
    }
    const flowState = await loadFlowState();
    if (flowState) {
      set({
        flows: flowState.flows,
        completedTasks: flowState.completedTasks,
      });
    }
  },

  rolloverSelectedTasks: async (fromDate, toDate, taskIds) => {
    try {
      await sendRollover(fromDate, toDate, taskIds);
    } catch {
      // Shown on the banner; the reload below shows what the server has.
    }
    const flowState = await loadFlowState();
    if (flowState) {
      set({
        flows: flowState.flows,
        completedTasks: flowState.completedTasks,
      });
    }
  },

  hydrate: async () => {
    try {
      const { flowState, settings } = await loadHydrationData();
      if (flowState) {
        set((state) => ({
          flows: flowState.flows,
          completedTasks: flowState.completedTasks,
          planningCompletedDates: { ...state.planningCompletedDates, ...flowState.planningCompletedDates },
        }));
      }
      if (settings) {
        set({ dayCapacityMins: settings.dayCapacityMins });
      }
    } catch {
      // Hydration failures should not block the app; the empty state is still usable.
    }
    set({ hydrated: true });
  },
}));

export function useCurrentFlowTaskIds(): string[] {
  const currentDate = useFlowStore((state) => state.currentDate);
  const flows = useFlowStore((state) => state.flows);
  return flows[currentDate] ?? [];
}

export function useCurrentCompletedTaskIds(): string[] {
  const currentDate = useFlowStore((state) => state.currentDate);
  const completedTasks = useFlowStore((state) => state.completedTasks);
  return completedTasks[currentDate] ?? [];
}

export function useFlowTasksForDate(date: string): Task[] {
  const flows = useFlowStore((state) => state.flows);
  const completedTasks = useFlowStore((state) => state.completedTasks);
  const tasks = useTodoistStore((state) => state.tasks);
  const ids = flows[date] ?? [];
  const quickTasks = getQuickTasksForDate(
    quickTaskCandidatesForDate(tasks, completedTasks, date),
    date
  );

  return ids
    .map((id) =>
      isQuickTaskPlaceholderId(id) && quickTasks.length > 0
        ? buildQuickTaskPlaceholder(quickTasks)
        : tasks.find((task) => task.id === id)
    )
    .filter((task): task is Task => task != null);
}

export function useCompletedTasksForDate(date: string): Task[] {
  const completedTasks = useFlowStore((state) => state.completedTasks);
  const tasks = useTodoistStore((state) => state.tasks);
  const ids = completedTasks[date] ?? [];
  const quickTasks = getQuickTasksForDate(
    quickTaskCandidatesForDate(tasks, completedTasks, date),
    date
  );

  return ids
    .map((id) =>
      isQuickTaskPlaceholderId(id)
        ? buildQuickTaskPlaceholder(quickTasks)
        : tasks.find((task) => task.id === id)
    )
    .filter((task): task is Task => task != null);
}
