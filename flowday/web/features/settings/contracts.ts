export interface SettingsResponse {
  todoist_api_key: string | null;
  has_api_key: boolean;
  last_sync_at: string | null;
  day_capacity_mins: number;
  planning_completed_today: boolean;
}

export interface SettingsUpdateBody {
  todoist_api_key?: string;
  day_capacity_mins?: number;
  planning_completed_date?: string;
}

export type ExportDataType = "entries" | "flows";
export type ExportFormat = "csv" | "json";
