/**
 * CSV and JSON exports, built in the browser from the raw rows of GET /api/analytics?start&end (the container era
 * built them in an /api/export route). Fields with a comma, quote or newline are quoted, quotes doubled.
 */
import { taskLookup } from "@/features/analytics/services/analytics-service";
import type { AnalyticsDataset } from "@/lib/types/worker-contract";
import { entryDurationSeconds } from "@/lib/utils/time-entries";
import type { ExportDataType, ExportFormat } from "../contracts";

export interface ExportFile {
  filename: string;
  contentType: string;
  body: string;
}

export type ExportResult = { ok: true; file: ExportFile } | { ok: false; status: 400; error: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csv<K extends string>(headers: readonly K[], rows: Record<K, unknown>[]): string {
  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => escapeCsvField(String(row[header]))).join(",")),
  ].join("\n");
}

function file(name: string, format: ExportFormat, rows: unknown[], body: () => string): ExportFile {
  return format === "json"
    ? { filename: `${name}.json`, contentType: "application/json", body: JSON.stringify(rows) }
    : { filename: `${name}.csv`, contentType: "text/csv", body: body() };
}

function exportEntries(dataset: AnalyticsDataset, startDate: string, endDate: string, format: ExportFormat): ExportFile {
  const entries = dataset.entries.filter((entry) => entry.flowDate >= startDate && entry.flowDate <= endDate);
  const taskMap = taskLookup(dataset, entries.map((entry) => entry.taskId));
  const rows = entries.map((entry) => ({
    date: entry.flowDate,
    taskId: entry.taskId,
    taskTitle: taskMap.get(entry.taskId)?.title ?? "Unknown",
    project: taskMap.get(entry.taskId)?.projectName ?? "",
    startTime: entry.startTime,
    endTime: entry.endTime ?? "",
    durationMins: Math.round(entryDurationSeconds(entry) / 60),
    source: entry.source,
  }));
  const headers = ["date", "taskId", "taskTitle", "project", "startTime", "endTime", "durationMins", "source"] as const;
  return file(`flowday-entries-${startDate}-to-${endDate}`, format, rows, () => csv(headers, rows));
}

function exportFlows(dataset: AnalyticsDataset, startDate: string, endDate: string, format: ExportFormat): ExportFile {
  const flowEntries = dataset.flows.filter((row) => row.flowDate >= startDate && row.flowDate <= endDate);
  const completedEntries = dataset.completed.filter((row) => row.flowDate >= startDate && row.flowDate <= endDate);
  const entries = dataset.entries.filter((entry) => entry.flowDate >= startDate && entry.flowDate <= endDate);
  const taskMap = taskLookup(dataset, [...flowEntries, ...completedEntries].map((row) => row.taskId));

  const completedByDate = new Map<string, Set<string>>();
  for (const entry of completedEntries) {
    if (!completedByDate.has(entry.flowDate)) completedByDate.set(entry.flowDate, new Set());
    completedByDate.get(entry.flowDate)!.add(entry.taskId);
  }
  const timeByTaskDate = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.flowDate}:${entry.taskId}`;
    timeByTaskDate.set(key, (timeByTaskDate.get(key) ?? 0) + entryDurationSeconds(entry));
  }

  const rows = flowEntries.map((entry) => {
    const task = taskMap.get(entry.taskId);
    return {
      date: entry.flowDate,
      taskId: entry.taskId,
      taskTitle: task?.title ?? "Unknown",
      project: task?.projectName ?? "",
      estimatedMins: task?.estimatedMins ?? 0,
      loggedMins: Math.round((timeByTaskDate.get(`${entry.flowDate}:${entry.taskId}`) ?? 0) / 60),
      completed: completedByDate.get(entry.flowDate)?.has(entry.taskId) ?? false,
    };
  });
  const headers = ["date", "taskId", "taskTitle", "project", "estimatedMins", "loggedMins", "completed"] as const;
  return file(`flowday-flows-${startDate}-to-${endDate}`, format, rows, () => csv(headers, rows));
}

/** Validates the export request (the container era's 400 messages); null when it is valid. */
export function exportRequestError(args: {
  startDate: string | null;
  endDate: string | null;
  type: string | null;
  format: string | null;
}): string | null {
  if (!args.startDate || !args.endDate || !DATE.test(args.startDate) || !DATE.test(args.endDate)) {
    return "start and end date params required";
  }
  if (!["csv", "json"].includes(args.format ?? "csv")) return "format must be csv or json";
  if (!["entries", "flows"].includes(args.type ?? "entries")) return "type must be entries or flows";
  return null;
}

export function exportData(
  args: { startDate: string | null; endDate: string | null; type: string | null; format: string | null },
  dataset: AnalyticsDataset
): ExportResult {
  const error = exportRequestError(args);
  if (error !== null || !args.startDate || !args.endDate) return { ok: false, status: 400, error: error ?? "" };
  const format = (args.format ?? "csv") as ExportFormat;
  const type = (args.type ?? "entries") as ExportDataType;
  return {
    ok: true,
    file:
      type === "entries"
        ? exportEntries(dataset, args.startDate, args.endDate, format)
        : exportFlows(dataset, args.startDate, args.endDate, format),
  };
}
