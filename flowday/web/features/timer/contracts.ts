/**
 * A time entry as the UI shows and sums it: the view model of a flowday.ui.v1 TimeEntry (lib/client/flowday-api.ts
 * builds it), with the start and end as ISO strings.
 */
export interface TimeEntry {
  id: string;
  taskId: string;
  flowDate: string;
  startTime: string;
  endTime: string | null;
  durationS: number | null;
  source: string;
}
