/**
 * One markdown note per (task, day) (flow_task_notes). Saving the same text again writes nothing.
 */
import { and, eq, sql } from 'drizzle-orm';
import type { NoteResponse } from '../api-types.ts';
import type { Db } from '../db.ts';
import { flowTaskNotes } from '../schema.ts';

export async function getNote(db: Db, taskId: string, flowDate: string): Promise<NoteResponse | null> {
  const [row] = await db
    .select({ taskId: flowTaskNotes.taskId, flowDate: flowTaskNotes.flowDate, content: flowTaskNotes.content, updatedAt: flowTaskNotes.updatedAt })
    .from(flowTaskNotes)
    .where(and(eq(flowTaskNotes.taskId, taskId), eq(flowTaskNotes.flowDate, flowDate)))
    .limit(1);
  return row ?? null;
}

export async function getNotesByDate(db: Db, flowDate: string): Promise<NoteResponse[]> {
  return db
    .select({ taskId: flowTaskNotes.taskId, flowDate: flowTaskNotes.flowDate, content: flowTaskNotes.content, updatedAt: flowTaskNotes.updatedAt })
    .from(flowTaskNotes)
    .where(eq(flowTaskNotes.flowDate, flowDate));
}

export async function upsertNote(db: Db, taskId: string, flowDate: string, content: string, now: Date = new Date()): Promise<NoteResponse> {
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
