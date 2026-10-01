export type SyncMode = "auto" | "manual";

/** POST /api/sync (worker/src/api-types.ts SyncResponse). */
export interface SyncResponse {
  status: "synced" | "partial" | "throttled";
  changed: number;
  fullSync: boolean;
  lastSyncAt: string | null;
  nextAutoSyncAt: number;
}
