import {
  loadFlows,
  loadSettings,
  persistFlowCompletion,
  persistFlowTasks,
  persistPlanningCompleted as persistPlanning,
  rolloverFlow,
  type FlowSnapshot,
  type SettingsView,
} from "@/lib/client/flowday-api";
import { formatLocalDate } from "@/lib/utils/time";

export function todayStr() {
  return formatLocalDate();
}

/** Saves a day's planned tasks in the background; on failure the banner shows it and `onFailure` reloads the flows. */
export function persistFlow(date: string, taskIds: string[], onFailure: () => void) {
  persistFlowTasks(date, taskIds, onFailure);
}

/** Saves a task's done mark of a day in the background; on failure the banner shows it and `onFailure` reloads. */
export function persistCompleted(date: string, taskId: string, done: boolean, onFailure: () => void) {
  persistFlowCompletion(date, taskId, done, onFailure);
}

/**
 * Moves the unfinished tasks of `fromDate` (or only `taskIds`) to the top of `toDate`. Throws (after the banner shows
 * it) when it was not saved.
 */
export async function sendRollover(fromDate: string, toDate: string, taskIds?: string[]): Promise<void> {
  await rolloverFlow(fromDate, toDate, taskIds);
}

export function persistPlanningCompleted(date: string) {
  persistPlanning(date);
}

export async function loadFlowState(): Promise<FlowSnapshot | null> {
  return loadFlows();
}

export async function loadHydrationData(): Promise<{
  flowState: FlowSnapshot | null;
  settings: SettingsView | null;
}> {
  const [flowState, settings] = await Promise.all([loadFlows(), loadSettings()]);
  return { flowState, settings };
}
