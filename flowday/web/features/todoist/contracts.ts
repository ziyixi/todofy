export interface SyncResponse {
  taskCount: number;
  lastSyncAt?: string | null;
  error?: string;
}
