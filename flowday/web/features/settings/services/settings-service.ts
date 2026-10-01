import { getSetting, setSetting } from "@/lib/db/queries/settings";
import { serviceError, serviceOk, type ServiceResult } from "@/lib/server/service-result";
import type { SettingsResponse, SettingsUpdateBody } from "../contracts";

function buildSettingsResponse(clientToday?: string | null): SettingsResponse {
  const capacityRaw = getSetting("day_capacity_mins");
  const planningCompleted = clientToday
    ? getSetting(`planning_completed:${clientToday}`) === "true"
    : false;

  return {
    todoist_api_key: getSetting("todoist_api_key") ? "••••••••" : null,
    has_api_key: !!getSetting("todoist_api_key"),
    last_sync_at: getSetting("last_sync_at"),
    day_capacity_mins: capacityRaw != null ? Number(capacityRaw) : 360,
    planning_completed_today: planningCompleted,
  };
}

export function getSettings(clientToday?: string | null): ServiceResult<SettingsResponse> {
  return serviceOk(buildSettingsResponse(clientToday));
}

export function updateSettings(
  body: SettingsUpdateBody
): ServiceResult<{ success: true }> {
  if ("todoist_api_key" in body) {
    if (typeof body.todoist_api_key !== "string" || !body.todoist_api_key.trim()) {
      return serviceError("API key is required", 400);
    }
    setSetting("todoist_api_key", body.todoist_api_key.trim());
  }

  if ("day_capacity_mins" in body) {
    const mins = Number(body.day_capacity_mins);
    if (Number.isNaN(mins) || mins < 0) {
      return serviceError("Invalid capacity value", 400);
    }
    setSetting("day_capacity_mins", String(mins));
  }

  if ("planning_completed_date" in body) {
    const date = body.planning_completed_date;
    if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setSetting(`planning_completed:${date}`, "true");
    }
  }

  return serviceOk({ success: true });
}
