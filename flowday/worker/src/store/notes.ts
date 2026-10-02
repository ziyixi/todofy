/**
 * One markdown note per (task, day) (flow_task_notes). Saving the same text again writes nothing.
 */
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { NoteRecord } from '../model.ts';
import type { Db } from '../db.ts';
import { flowTaskNotes } from '../schema.ts';

export async function getNote(db: Db, taskId: string, flowDate: string): Promise<NoteRecord | null> {
  const [row] = await db
    .select({ taskId: flowTaskNotes.taskId, flowDate: flowTaskNotes.flowDate, content: flowTaskNotes.content, updatedAt: flowTaskNotes.updatedAt })
    .from(flowTaskNotes)
    .where(and(eq(flowTaskNotes.taskId, taskId), eq(flowTaskNotes.flowDate, flowDate)))
    .limit(1);
  return row ?? null;
}

export async function getNotesByDate(db: Db, flowDate: string): Promise<NoteRecord[]> {
  return db
    .select({ taskId: flowTaskNotes.taskId, flowDate: flowTaskNotes.flowDate, content: flowTaskNotes.content, updatedAt: flowTaskNotes.updatedAt })
    .from(flowTaskNotes)
    .where(eq(flowTaskNotes.flowDate, flowDate));
}

export async function upsertNote(db: Db, taskId: string, flowDate: string, content: string, now: Date = new Date()): Promise<NoteRecord> {
  const updatedAt = now.toISOString();
  await db
    .insert(flowTaskNotes)
    .values({ id: crypto.randomUUID(), taskId, flowDate, content, updatedAt })
    .onConflictDoUpdate({
      target: [flowTaskNotes.taskId, flowTaskNotes.flowDate],
      set: { content, updatedAt },
      setWhere: sql`${flowTaskNotes.content} IS NOT excluded.content`,
    });
  return (await getNote(db, taskId, flowDate)) ?? { taskId, flowDate, content, updatedAt };
}

/** The query of a page of the notes written on a day, in task ID order, after the task ID `afterTaskId`. */
export function listNotesQuery(db: Db, flowDate: string, afterTaskId: string, limit: number) {
  return db
    .select({ taskId: flowTaskNotes.taskId, flowDate: flowTaskNotes.flowDate, content: flowTaskNotes.content, updatedAt: flowTaskNotes.updatedAt })
    .from(flowTaskNotes)
    .where(and(eq(flowTaskNotes.flowDate, flowDate), gt(flowTaskNotes.taskId, afterTaskId)))
    .orderBy(asc(flowTaskNotes.taskId))
    .limit(limit + 1);
}

/** A page of the notes written on a day, in task ID order, after the task ID `afterTaskId` ('' for the first page). */
export async function listNotes(db: Db, flowDate: string, afterTaskId: string, limit: number): Promise<{ notes: NoteRecord[]; more: boolean }> {
  const rows = await listNotesQuery(db, flowDate, afterTaskId, limit);
  return { notes: rows.slice(0, limit), more: rows.length > limit };
}
