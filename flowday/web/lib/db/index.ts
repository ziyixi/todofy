import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import path from "node:path";
import fs from "node:fs";

const DB_PATH = path.join(process.cwd(), "db", "flowday.db");

const globalForDb = globalThis as unknown as {
  __flowdayDb?: ReturnType<typeof drizzle<typeof schema>>;
  __flowdaySqlite?: InstanceType<typeof Database>;
};

export function getDb() {
  if (globalForDb.__flowdayDb) return globalForDb.__flowdayDb;

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const sqlite = new Database(DB_PATH);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  globalForDb.__flowdaySqlite = sqlite;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS time_entries (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      flow_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      duration_s INTEGER,
      source TEXT NOT NULL DEFAULT 'timer',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      todoist_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      project_name TEXT,
      project_color TEXT,
      priority INTEGER NOT NULL DEFAULT 1,
      labels TEXT DEFAULT '[]',
      estimated_mins INTEGER,
      is_completed INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      due_date TEXT,
      created_at TEXT,
      synced_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS flow_tasks (
      id TEXT PRIMARY KEY,
      flow_date TEXT NOT NULL,
      task_id TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      UNIQUE(flow_date, task_id)
    );

    CREATE TABLE IF NOT EXISTS completed_flow_tasks (
      id TEXT PRIMARY KEY,
      flow_date TEXT NOT NULL,
      task_id TEXT NOT NULL,
      UNIQUE(flow_date, task_id)
    );

    CREATE TABLE IF NOT EXISTS flow_task_notes (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      flow_date TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(task_id, flow_date)
    );

    CREATE TABLE IF NOT EXISTS active_timer_session (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      flow_date TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      timer_mode TEXT NOT NULL DEFAULT 'countup',
      pomodoro_target_s INTEGER,
      segment_wall_start TEXT,
      session_saved_s INTEGER NOT NULL DEFAULT 0,
      pomodoro_finished_task_id TEXT,
      pomodoro_finished_flow_date TEXT,
      pomodoro_finished_target_s INTEGER,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_time_entries_task_id ON time_entries(task_id);
    CREATE INDEX IF NOT EXISTS idx_time_entries_flow_date ON time_entries(flow_date);
    CREATE INDEX IF NOT EXISTS idx_flow_tasks_flow_date ON flow_tasks(flow_date);
    CREATE INDEX IF NOT EXISTS idx_flow_tasks_task_id ON flow_tasks(task_id);
    CREATE INDEX IF NOT EXISTS idx_completed_flow_tasks_flow_date ON completed_flow_tasks(flow_date);
    CREATE INDEX IF NOT EXISTS idx_completed_flow_tasks_task_id ON completed_flow_tasks(task_id);
    CREATE INDEX IF NOT EXISTS idx_flow_task_notes_flow_date ON flow_task_notes(flow_date);
    CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
  `);

  // Lightweight migrations: add columns that may not exist yet
  const cols = sqlite.pragma("table_info(tasks)") as { name: string }[];
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("description")) {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN description TEXT");
  }
  if (!colNames.has("deleted_at")) {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN deleted_at TEXT");
  }
  if (!colNames.has("deleted_source")) {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN deleted_source TEXT");
  }
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at ON tasks(deleted_at)");
  sqlite.exec("CREATE INDEX IF NOT EXISTS idx_tasks_todoist_id ON tasks(todoist_id)");

  const db = drizzle(sqlite, { schema });
  globalForDb.__flowdayDb = db;
  return db;
}
