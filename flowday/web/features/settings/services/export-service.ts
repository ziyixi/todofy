import { NextResponse } from "next/server";
import {
  getCompletedTaskIdsInDateRange,
  getFlowTaskIdsInDateRange,
} from "@/lib/db/queries/flows";
import { getEntriesInDateRange } from "@/lib/db/queries/entries";
import {
  getTasksByIds,
} from "@/lib/db/queries/tasks";
import { serviceError, serviceOk, type ServiceResult } from "@/lib/server/service-result";
import { entryDurationSeconds } from "@/lib/utils/time-entries";
import type { ExportDataType, ExportFormat } from "../contracts";

function escapeCsvField(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function buildCsvResponse(filename: string, rows: string[]) {
  return new Response(rows.join("\n"), {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

function exportEntries(
  startDate: string,
  endDate: string,
  format: ExportFormat
): Response {
  const entries = getEntriesInDateRange(startDate, endDate);
  const taskIds = [...new Set(entries.map((entry) => entry.taskId))];
  const taskMap = new Map(getTasksByIds(taskIds).map((task) => [task.id, task]));

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

  if (format === "json") {
    return NextResponse.json(rows);
  }

  const headers = [
    "date",
    "taskId",
    "taskTitle",
    "project",
    "startTime",
    "endTime",
    "durationMins",
    "source",
  ] as const;
  const csvRows = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => escapeCsvField(String(row[header]))).join(",")),
  ];

  return buildCsvResponse(
    `flowday-entries-${startDate}-to-${endDate}.csv`,
    csvRows
  );
}

function exportFlows(
  startDate: string,
  endDate: string,
  format: ExportFormat
): Response {
  const flowEntries = getFlowTaskIdsInDateRange(startDate, endDate);
  const completedEntries = getCompletedTaskIdsInDateRange(startDate, endDate);
  const entries = getEntriesInDateRange(startDate, endDate);
  const allTaskIds = [
    ...new Set([
      ...flowEntries.map((entry) => entry.taskId),
      ...completedEntries.map((entry) => entry.taskId),
    ]),
  ];
  const taskMap = new Map(getTasksByIds(allTaskIds).map((task) => [task.id, task]));

  const completedByDate = new Map<string, Set<string>>();
  for (const entry of completedEntries) {
    if (!completedByDate.has(entry.flowDate)) {
      completedByDate.set(entry.flowDate, new Set());
    }
    completedByDate.get(entry.flowDate)!.add(entry.taskId);
  }

  const timeByTaskDate = new Map<string, number>();
  for (const entry of entries) {
    const key = `${entry.flowDate}:${entry.taskId}`;
    timeByTaskDate.set(
      key,
      (timeByTaskDate.get(key) ?? 0) + entryDurationSeconds(entry)
    );
  }

  const rows = flowEntries.map((entry) => {
    const task = taskMap.get(entry.taskId);
    const completed = completedByDate.get(entry.flowDate)?.has(entry.taskId) ?? false;
    const loggedSecs = timeByTaskDate.get(`${entry.flowDate}:${entry.taskId}`) ?? 0;
    return {
      date: entry.flowDate,
      taskId: entry.taskId,
      taskTitle: task?.title ?? "Unknown",
      project: task?.projectName ?? "",
      estimatedMins: task?.estimatedMins ?? 0,
      loggedMins: Math.round(loggedSecs / 60),
      completed,
    };
  });

  if (format === "json") {
    return NextResponse.json(rows);
  }

  const headers = [
    "date",
    "taskId",
    "taskTitle",
    "project",
    "estimatedMins",
    "loggedMins",
    "completed",
  ] as const;
  const csvRows = [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => escapeCsvField(String(row[header]))).join(",")),
  ];

  return buildCsvResponse(
    `flowday-flows-${startDate}-to-${endDate}.csv`,
    csvRows
  );
}

export function exportData(args: {
  startDate: string | null;
  endDate: string | null;
  type: string | null;
  format: string | null;
}): ServiceResult<Response> {
  const format = (args.format ?? "csv") as ExportFormat;
  const type = (args.type ?? "entries") as ExportDataType;

  if (!args.startDate || !args.endDate) {
    return serviceError("start and end date params required", 400);
  }
  if (!["csv", "json"].includes(format)) {
    return serviceError("format must be csv or json", 400);
  }
  if (!["entries", "flows"].includes(type)) {
    return serviceError("type must be entries or flows", 400);
  }

  const response =
    type === "entries"
      ? exportEntries(args.startDate, args.endDate, format)
      : exportFlows(args.startDate, args.endDate, format);
  return serviceOk(response);
}
