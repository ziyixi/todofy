import { getDb } from "../index";
import type { Task, TaskPriority } from "@/lib/types/task";

export interface TaskRow {
  id: string;
  todoistId: string | null;
  title: string;
  description: string | null;
  projectName: string | null;
  projectColor: string | null;
  priority: number;
  labels: string | null;
  estimatedMins: number | null;
  isCompleted: number;
  completedAt: string | null;
  dueDate: string | null;
  createdAt: string | null;
  syncedAt: string | null;
  deletedAt: string | null;
}

interface TransactionCapableDb {
  $client: {
    transaction: (fn: () => void) => () => void;
  };
}

export function runDbTransaction(fn: () => void): void {
  const db = getDb();
  const rawDb = (db as unknown as TransactionCapableDb).$client;
  rawDb.transaction(fn)();
}

export function mapTaskRow(row: TaskRow): Task {
  return {
    id: row.id,
    todoistId: row.todoistId,
    title: row.title,
    description: row.description,
    projectName: row.projectName,
    projectColor: row.projectColor,
    priority: (row.priority as TaskPriority) || 1,
    labels: JSON.parse(row.labels || "[]"),
    estimatedMins: row.estimatedMins,
    isCompleted: row.isCompleted === 1,
    completedAt: row.completedAt,
    dueDate: row.dueDate,
    createdAt: row.createdAt || new Date().toISOString(),
    deletedAt: row.deletedAt ?? null,
  };
}
