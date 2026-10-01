/**
 * The Worker's API shapes (worker/src/api-types.ts, type-only) and compile-time checks that the UI's own types
 * describe the same JSON: `npm run typecheck` fails when either side changes alone.
 */
import type {
  ActiveTimerSession as WorkerTimerSession,
  AnalyticsDataset,
  FlowStateResponse as WorkerFlowState,
  SettingsResponse as WorkerSettings,
  SyncResponse as WorkerSync,
  Task as WorkerTask,
  TimeEntry as WorkerTimeEntry,
} from "../../../worker/src/api-types";
import type { FlowStateResponse } from "@/features/flow/contracts";
import type { SettingsResponse } from "@/features/settings/contracts";
import type { TimeEntry, TimerSessionPayload } from "@/features/timer/contracts";
import type { SyncResponse } from "@/features/todoist/contracts";
import type { Task } from "./task";

export type { AnalyticsDataset };

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type WorkerContractChecks = [
  Assert<Same<Task, WorkerTask>>,
  Assert<Same<FlowStateResponse, WorkerFlowState>>,
  Assert<Same<SettingsResponse, WorkerSettings>>,
  Assert<Same<SyncResponse, WorkerSync>>,
  Assert<Same<TimerSessionPayload, WorkerTimerSession>>,
  // The UI reads a subset of an entry's columns.
  Assert<WorkerTimeEntry extends TimeEntry ? true : false>,
];
