import { apiGetOrNull, apiSend, apiSendOk } from "@/lib/client/http";
import { formatLocalDate } from "@/lib/utils/time";
import type { FlowMutationAction, FlowStateResponse } from "../contracts";
import type { SettingsResponse } from "@/features/settings/contracts";

export function todayStr() {
  return formatLocalDate();
}

/** Saves a flow change in the background; on failure the banner shows it and `onFailure` reloads the flows. */
export function persistFlowMutation(body: FlowMutationAction, onFailure: () => void) {
  void apiSendOk("PUT", "/api/flows", body).then((saved) => {
    if (!saved) onFailure();
  });
}

/** Throws (after the banner shows it) when the change was not saved. */
export async function sendFlowMutation(body: FlowMutationAction): Promise<void> {
  await apiSend("PUT", "/api/flows", body);
}

export function persistPlanningCompleted(date: string) {
  void apiSendOk("PUT", "/api/settings", { planning_completed_date: date });
}

export async function loadFlowState(): Promise<FlowStateResponse | null> {
  const data = await apiGetOrNull<FlowStateResponse>("/api/flows");
  if (!data) return null;
  return {
    flows: data.flows ?? {},
    completedTasks: data.completedTasks ?? {},
  };
}

export async function loadHydrationData(today: string): Promise<{
  flowState: FlowStateResponse | null;
  settings: SettingsResponse | null;
}> {
  const [flowState, settings] = await Promise.all([
    apiGetOrNull<FlowStateResponse>("/api/flows"),
    apiGetOrNull<SettingsResponse>(`/api/settings?today=${encodeURIComponent(today)}`),
  ]);

  return { flowState, settings };
}
