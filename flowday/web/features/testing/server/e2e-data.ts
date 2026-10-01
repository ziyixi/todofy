import { eq } from "drizzle-orm";
import { createTimeEntry } from "@/lib/db/queries/entries";
import { setFlowTaskIds } from "@/lib/db/queries/flows";
import { upsertNote } from "@/lib/db/queries/notes";
import { setSetting } from "@/lib/db/queries/settings";
import { upsertTasks } from "@/lib/db/queries/tasks";
import { getDb } from "@/lib/db/index";
import {
  activeTimerSession,
  completedFlowTasks,
  flowTaskNotes,
  flowTasks,
  settings,
  tasks,
  timeEntries,
} from "@/lib/db/schema";
import type { Task, TaskPriority } from "@/lib/types/task";

export interface E2ETaskSeed {
  id: string;
  todoistId?: string | null;
  title: string;
  description?: string | null;
  projectName?: string | null;
  projectColor?: string | null;
  priority?: TaskPriority;
  labels?: string[];
  estimatedMins?: number | null;
  isCompleted?: boolean;
  completedAt?: string | null;
  dueDate?: string | null;
  createdAt?: string;
  deletedAt?: string | null;
}

export interface E2ETimeEntrySeed {
  id?: string;
  taskId: string;
  flowDate: string;
  startTime: string;
  endTime?: string | null;
  durationS?: number | null;
  source?: "timer" | "manual";
}

export interface E2ENoteSeed {
  taskId: string;
  flowDate: string;
  content: string;
}

export interface E2ESeedPayload {
  tasks?: E2ETaskSeed[];
  flows?: Record<string, string[]>;
  completedTasks?: Record<string, string[]>;
  notes?: E2ENoteSeed[];
  timeEntries?: E2ETimeEntrySeed[];
  settings?: Record<string, string | number | boolean>;
}

function toTask(seed: E2ETaskSeed): Task {
  return {
    id: seed.id,
    todoistId: seed.todoistId ?? null,
    title: seed.title,
    description: seed.description ?? null,
    projectName: seed.projectName ?? null,
    projectColor: seed.projectColor ?? null,
    priority: seed.priority ?? 1,
    labels: seed.labels ?? [],
    estimatedMins: seed.estimatedMins ?? null,
    isCompleted: seed.isCompleted ?? false,
    completedAt: seed.completedAt ?? null,
    dueDate: seed.dueDate ?? null,
    createdAt: seed.createdAt ?? new Date().toISOString(),
    deletedAt: seed.deletedAt ?? null,
  };
}

export function isE2ETestModeEnabled() {
  return process.env.E2E_TEST_MODE === "1";
}

export function clearE2ETestData(): void {
  const db = getDb();
  const rawDb = (db as unknown as {
    $client: { transaction: (fn: () => void) => () => void };
  }).$client;

  const runTx = rawDb.transaction(() => {
    db.delete(flowTaskNotes).run();
    db.delete(completedFlowTasks).run();
    db.delete(flowTasks).run();
    db.delete(timeEntries).run();
    db.delete(tasks).run();
    db.delete(settings).run();
    db.delete(activeTimerSession).run();
  });

  runTx();
}

export function seedE2ETestData(payload: E2ESeedPayload): void {
  if (payload.tasks?.length) {
    upsertTasks(payload.tasks.map(toTask));

    for (const taskSeed of payload.tasks) {
      if (taskSeed.deletedAt != null) {
        const db = getDb();
        db.update(tasks)
          .set({ deletedAt: taskSeed.deletedAt })
          .where(eq(tasks.id, taskSeed.id))
          .run();
      }
    }
  }

  if (payload.flows) {
    for (const [flowDate, taskIds] of Object.entries(payload.flows)) {
      setFlowTaskIds(flowDate, taskIds);
    }
  }

  if (payload.completedTasks) {
    const db = getDb();
    for (const [flowDate, taskIds] of Object.entries(payload.completedTasks)) {
      for (const taskId of taskIds) {
        db.insert(completedFlowTasks)
          .values({ id: crypto.randomUUID(), flowDate, taskId })
          .onConflictDoNothing()
          .run();
      }
    }
  }

  if (payload.notes?.length) {
    for (const note of payload.notes) {
      upsertNote(note.taskId, note.flowDate, note.content);
    }
  }

  if (payload.timeEntries?.length) {
    for (const entry of payload.timeEntries) {
      createTimeEntry({
        id: entry.id ?? crypto.randomUUID(),
        taskId: entry.taskId,
        flowDate: entry.flowDate,
        startTime: entry.startTime,
        endTime: entry.endTime ?? null,
        durationS: entry.durationS ?? null,
        source: entry.source ?? "timer",
      });
    }
  }

  if (payload.settings) {
    for (const [key, value] of Object.entries(payload.settings)) {
      setSetting(key, String(value));
    }
  }
}
