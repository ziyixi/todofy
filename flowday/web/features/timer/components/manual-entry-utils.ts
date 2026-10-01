import { format } from "date-fns";

export function formatTimeRange(start: string, end: string | null): string {
  const startDate = new Date(start);
  const startStr = format(startDate, "HH:mm");
  if (!end) return `${startStr} – …`;
  const endDate = new Date(end);
  const endStr = format(endDate, "HH:mm");
  return `${startStr} – ${endStr}`;
}

export function formatDurationShort(seconds: number | null): string {
  if (!seconds || seconds <= 0) return "";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}h ${remainder}m` : `${hours}h`;
}
