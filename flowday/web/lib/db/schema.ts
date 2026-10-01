import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const timeEntries = sqliteTable("time_entries", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  flowDate: text("flow_date").notNull(),
  startTime: text("start_time").notNull(),
  endTime: text("end_time"),
  durationS: integer("duration_s"),
  source: text("source").notNull().default("timer"),
  createdAt: text("created_at").default(sql`(datetime('now'))`),
});

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  todoistId: text("todoist_id"),
  title: text("title").notNull(),
  description: text("description"),
  projectName: text("project_name"),
  projectColor: text("project_color"),
  priority: integer("priority").notNull().default(1),
  labels: text("labels").default("[]"),
  estimatedMins: integer("estimated_mins"),
  isCompleted: integer("is_completed").notNull().default(0),
  completedAt: text("completed_at"),
  dueDate: text("due_date"),
  createdAt: text("created_at"),
  syncedAt: text("synced_at"),
  deletedAt: text("deleted_at"),
  // 'sync' = Todoist no longer returns this task; 'local' or null = user-initiated.
  // Sync-deleted tasks auto-restore if Todoist starts returning them again.
  deletedSource: text("deleted_source"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
});

export const flowTasks = sqliteTable("flow_tasks", {
  id: text("id").primaryKey(),
  flowDate: text("flow_date").notNull(),
  taskId: text("task_id").notNull(),
  sortOrder: integer("sort_order").notNull(),
});

export const completedFlowTasks = sqliteTable("completed_flow_tasks", {
  id: text("id").primaryKey(),
  flowDate: text("flow_date").notNull(),
  taskId: text("task_id").notNull(),
});

export const flowTaskNotes = sqliteTable("flow_task_notes", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  flowDate: text("flow_date").notNull(),
  content: text("content").notNull().default(""),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});

// Singleton row (`id = 'main'`) holding whatever timer the user is currently
// running. Persisted server-side so that starting a pomodoro on one device and
// switching to another picks up where it left off instead of silently dropping
// the session.
export const activeTimerSession = sqliteTable("active_timer_session", {
  id: text("id").primaryKey(),
  taskId: text("task_id"),
  flowDate: text("flow_date"),
  status: text("status").notNull().default("idle"),
  timerMode: text("timer_mode").notNull().default("countup"),
  pomodoroTargetS: integer("pomodoro_target_s"),
  segmentWallStart: text("segment_wall_start"),
  sessionSavedS: integer("session_saved_s").notNull().default(0),
  pomodoroFinishedTaskId: text("pomodoro_finished_task_id"),
  pomodoroFinishedFlowDate: text("pomodoro_finished_flow_date"),
  pomodoroFinishedTargetS: integer("pomodoro_finished_target_s"),
  updatedAt: text("updated_at").default(sql`(datetime('now'))`),
});
