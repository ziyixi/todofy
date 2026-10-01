import { and, eq, gte, lte } from "drizzle-orm";
import { getDb } from "../index";
import { completedFlowTasks, flowTasks } from "../schema";
import { runDbTransaction } from "./shared";

export function getAllFlows(): Record<string, string[]> {
  const db = getDb();
  const rows = db.select().from(flowTasks).orderBy(flowTasks.sortOrder).all();
  const result: Record<string, string[]> = {};
  for (const row of rows) {
    if (!result[row.flowDate]) result[row.flowDate] = [];
    result[row.flowDate].push(row.taskId);
  }
  return result;
}

export function setFlowTaskIds(flowDate: string, taskIds: string[]): void {
  const db = getDb();
  runDbTransaction(() => {
    db.delete(flowTasks).where(eq(flowTasks.flowDate, flowDate)).run();
    for (let i = 0; i < taskIds.length; i += 1) {
      db.insert(flowTasks)
        .values({
          id: crypto.randomUUID(),
          flowDate,
          taskId: taskIds[i],
          sortOrder: i,
        })
        .run();
    }
  });
}

export function getAllCompletedFlowTasks(): Record<string, string[]> {
  const db = getDb();
  const rows = db.select().from(completedFlowTasks).all();
  const result: Record<string, string[]> = {};
  for (const row of rows) {
    if (!result[row.flowDate]) result[row.flowDate] = [];
    result[row.flowDate].push(row.taskId);
  }
  return result;
}

export function addCompletedFlowTask(flowDate: string, taskId: string): void {
  const db = getDb();
  db.insert(completedFlowTasks)
    .values({ id: crypto.randomUUID(), flowDate, taskId })
    .onConflictDoNothing()
    .run();
}

export function removeCompletedFlowTask(flowDate: string, taskId: string): void {
  const db = getDb();
  db.delete(completedFlowTasks)
    .where(
      and(
        eq(completedFlowTasks.flowDate, flowDate),
        eq(completedFlowTasks.taskId, taskId)
      )
    )
    .run();
}

export function getFlowTaskIdsInDateRange(
  startDate: string,
  endDate: string
): { flowDate: string; taskId: string }[] {
  const db = getDb();
  return db
    .select({ flowDate: flowTasks.flowDate, taskId: flowTasks.taskId })
    .from(flowTasks)
    .where(and(gte(flowTasks.flowDate, startDate), lte(flowTasks.flowDate, endDate)))
    .all();
}

export function getCompletedTaskIdsInDateRange(
  startDate: string,
  endDate: string
): { flowDate: string; taskId: string }[] {
  const db = getDb();
  return db
    .select({ flowDate: completedFlowTasks.flowDate, taskId: completedFlowTasks.taskId })
    .from(completedFlowTasks)
    .where(
      and(
        gte(completedFlowTasks.flowDate, startDate),
        lte(completedFlowTasks.flowDate, endDate)
      )
    )
    .all();
}
