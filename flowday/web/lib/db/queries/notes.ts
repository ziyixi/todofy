import { and, eq } from "drizzle-orm";
import { getDb } from "../index";
import { flowTaskNotes } from "../schema";

export interface FlowTaskNoteRow {
  id: string;
  taskId: string;
  flowDate: string;
  content: string;
  updatedAt: string | null;
}

export function getNote(taskId: string, flowDate: string): FlowTaskNoteRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(flowTaskNotes)
    .where(and(eq(flowTaskNotes.taskId, taskId), eq(flowTaskNotes.flowDate, flowDate)))
    .get();
  return (row as FlowTaskNoteRow | undefined) ?? null;
}

export function getNotesByDate(flowDate: string): FlowTaskNoteRow[] {
  const db = getDb();
  return db
    .select()
    .from(flowTaskNotes)
    .where(eq(flowTaskNotes.flowDate, flowDate))
    .all() as FlowTaskNoteRow[];
}

export function upsertNote(
  taskId: string,
  flowDate: string,
  content: string
): FlowTaskNoteRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.insert(flowTaskNotes)
    .values({ id, taskId, flowDate, content, updatedAt: now })
    .onConflictDoUpdate({
      target: [flowTaskNotes.taskId, flowTaskNotes.flowDate],
      set: { content, updatedAt: now },
    })
    .run();
  return getNote(taskId, flowDate)!;
}
