import { fetchJsonNoStore, jsonRequestInit } from "@/lib/client/http";
import { formatLocalDate } from "@/lib/utils/time";
import type { FlowMutationAction, FlowStateResponse } from "../contracts";
import type { SettingsResponse } from "@/features/settings/contracts";

export function todayStr() {
  return formatLocalDate();
}

export function persistFlowMutation(
  body: FlowMutationAction | { action: "addCompleted" | "removeCompleted"; date: string; taskId: string },
  onFailure: () => void
) {
  fetch("/api/flows", jsonRequestInit("PUT", body))
    .then((response) => {
      if (!response.ok) onFailure();
    })
    .catch(() => onFailure());
}

export function persistPlanningCompleted(date: string) {
  void fetch(
    "/api/settings",
    jsonRequestInit("PUT", { planning_completed_date: date })
  ).catch(() => {});
}

export async function loadFlowState(): Promise<FlowStateResponse | null> {
  const data = await fetchJsonNoStore<FlowStateResponse>("/api/flows");
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
    fetchJsonNoStore<FlowStateResponse>("/api/flows"),
    fetchJsonNoStore<SettingsResponse>(
      `/api/settings?today=${encodeURIComponent(today)}`
    ),
  ]);

  return { flowState, settings };
}
