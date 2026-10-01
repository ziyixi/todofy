/**
 * The D1 tables (../../migrations/), as drizzle-orm sees them. 0001 is the container-era SQLite schema unchanged;
 * 0002 adds tasks.todoist_project_id for the incremental Todoist sync.
 */
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const timeEntries = sqliteTable('time_entries', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  flowDate: text('flow_date').notNull(),
  startTime: text('start_time').notNull(),
  endTime: text('end_time'),
  durationS: integer('duration_s'),
  source: text('source').notNull().default('timer'),
  createdAt: text('created_at'),
});

export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  todoistId: text('todoist_id'),
  title: text('title').notNull(),
  projectName: text('project_name'),
  projectColor: text('project_color'),
  priority: integer('priority').notNull().default(1),
  labels: text('labels').default('[]'),
  estimatedMins: integer('estimated_mins'),
  isCompleted: integer('is_completed').notNull().default(0),
  completedAt: text('completed_at'),
  dueDate: text('due_date'),
  createdAt: text('created_at'),
  syncedAt: text('synced_at'),
  description: text('description'),
  deletedAt: text('deleted_at'),
  // 'sync' = Todoist no longer lists this task (completed or deleted there); 'local' or null = deleted in FlowDay.
  // Sync-deleted tasks come back by themselves when Todoist lists them again.
  deletedSource: text('deleted_source'),
  todoistProjectId: text('todoist_project_id'),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
});

export const flowTasks = sqliteTable('flow_tasks', {
  id: text('id').primaryKey(),
  flowDate: text('flow_date').notNull(),
  taskId: text('task_id').notNull(),
  sortOrder: integer('sort_order').notNull(),
});

export const completedFlowTasks = sqliteTable('completed_flow_tasks', {
  id: text('id').primaryKey(),
  flowDate: text('flow_date').notNull(),
  taskId: text('task_id').notNull(),
});

export const flowTaskNotes = sqliteTable('flow_task_notes', {
  id: text('id').primaryKey(),
  taskId: text('task_id').notNull(),
  flowDate: text('flow_date').notNull(),
  content: text('content').notNull().default(''),
  updatedAt: text('updated_at'),
});

/**
 * One row (`id = 'main'`): the timer currently running, so a pomodoro started on one device continues on another.
 */
export const activeTimerSession = sqliteTable('active_timer_session', {
  id: text('id').primaryKey(),
  taskId: text('task_id'),
  flowDate: text('flow_date'),
  status: text('status').notNull().default('idle'),
  timerMode: text('timer_mode').notNull().default('countup'),
  pomodoroTargetS: integer('pomodoro_target_s'),
  segmentWallStart: text('segment_wall_start'),
  sessionSavedS: integer('session_saved_s').notNull().default(0),
  pomodoroFinishedTaskId: text('pomodoro_finished_task_id'),
  pomodoroFinishedFlowDate: text('pomodoro_finished_flow_date'),
  pomodoroFinishedTargetS: integer('pomodoro_finished_target_s'),
  updatedAt: text('updated_at'),
});
