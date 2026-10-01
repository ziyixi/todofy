import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import {
  getAllTasks,
  getDeletedTasks,
  markOrphanedTodoistTasksDeleted,
  upsertTasks,
} from "@/lib/db/queries/tasks";
import { getDb } from "@/lib/db";
import type { Task } from "@/lib/types/task";

/**
 * Schema-migration & legacy-data tests.
 *
 * The dev DB gets wiped per-test by setup.ts, but production DBs persist
 * across releases. These tests simulate "user upgrades FlowDay" scenarios
 * by writing an older table layout to disk before getDb() runs migrations,
 * then asserting that the migration is additive and that legacy rows behave
 * sensibly in the new query paths.
 */

const DB_PATH = path.join(process.cwd(), "db", "flowday.db");

function closeCachedDb() {
  const g = globalThis as unknown as {
    __flowdayDb?: unknown;
    __flowdaySqlite?: { close(): void };
  };
  if (g.__flowdaySqlite) {
    try { g.__flowdaySqlite.close(); } catch { /* already closed */ }
  }
  delete g.__flowdaySqlite;
  delete g.__flowdayDb;
}

function deleteDbFiles() {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const p = DB_PATH + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

function readRawTaskRow(id: string): { deleted_at: string | null; deleted_source: string | null } | undefined {
  // Peek the raw row — getDeletedTasks() hides sync-deleted rows from the UI
  // on purpose, but the DB still tracks them for the auto-restore path.
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db
      .prepare("SELECT deleted_at, deleted_source FROM tasks WHERE id = ?")
      .get(id) as { deleted_at: string | null; deleted_source: string | null } | undefined;
  } finally {
    db.close();
  }
}

function makeStoredTodoistTask(id: string): Task {
  return {
    id,
    todoistId: id,
    title: `Task ${id}`,
    description: null,
    projectName: null,
    projectColor: null,
    priority: 1,
    labels: [],
    estimatedMins: null,
    isCompleted: false,
    completedAt: null,
    dueDate: null,
    createdAt: "2026-04-01T00:00:00Z",
    deletedAt: null,
  };
}

beforeEach(() => {
  // setup.ts already wiped the DB — start each migration test with the
  // cache cleared and the file gone so we can lay down a custom schema.
  closeCachedDb();
  deleteDbFiles();
});

describe("schema migration — additive ALTER TABLE", () => {
  it("adds deleted_at and deleted_source to a pre-existing tasks table without losing rows", () => {
    // Write a legacy tasks table that pre-dates both deleted_at and deleted_source.
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const legacy = new Database(DB_PATH);
    legacy.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        todoist_id TEXT,
        title TEXT NOT NULL,
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
      INSERT INTO tasks (id, todoist_id, title, priority, labels, is_completed, created_at)
      VALUES ('legacy-1', 'td-legacy-1', 'Pre-migration task', 1, '[]', 0, '2026-01-01T00:00:00Z');
    `);
    legacy.close();

    // First call to getDb() runs migrations on the existing file.
    getDb();

    const cols = (
      new Database(DB_PATH).pragma("table_info(tasks)") as { name: string }[]
    ).map((c) => c.name);
    expect(cols).toContain("description");
    expect(cols).toContain("deleted_at");
    expect(cols).toContain("deleted_source");

    const rows = getAllTasks();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("legacy-1");
    expect(rows[0].title).toBe("Pre-migration task");
    expect(rows[0].deletedAt).toBeNull();
  });

  it("is a no-op when re-run on an already-migrated DB", () => {
    // First boot creates the schema.
    upsertTasks([makeStoredTodoistTask("td-1")]);
    closeCachedDb();

    // Second boot must NOT throw on duplicate ALTER TABLE attempts and
    // must preserve the row.
    expect(() => getDb()).not.toThrow();
    expect(getAllTasks()).toHaveLength(1);
  });
});

describe("legacy soft-deletes with NULL deleted_source", () => {
  it("treats a pre-migration soft-deleted row as user-trash (does NOT auto-restore on sync)", () => {
    // Simulate a row written by an older FlowDay version: deleted_at set,
    // deleted_source column didn't exist yet so it migrates in as NULL.
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const legacy = new Database(DB_PATH);
    legacy.exec(`
      CREATE TABLE tasks (
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
        synced_at TEXT,
        deleted_at TEXT
      );
      INSERT INTO tasks (id, todoist_id, title, priority, labels, is_completed, created_at, deleted_at)
      VALUES ('legacy-trash', 'td-legacy', 'User trashed before upgrade', 1, '[]', 0,
              '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z');
    `);
    legacy.close();

    getDb(); // run migration → adds deleted_source column with NULL for this row

    expect(getAllTasks()).toHaveLength(0);
    expect(getDeletedTasks().map((t) => t.id)).toEqual(["legacy-trash"]);

    // Sync brings the same Todoist task back in. Auto-restore should ONLY
    // fire for deleted_source='sync'; legacy NULL must be preserved as
    // user-trash so the user's intentional hide isn't undone by a release.
    upsertTasks([
      { ...makeStoredTodoistTask("legacy-trash"), title: "Resurrected by sync" },
    ]);
    expect(getAllTasks()).toHaveLength(0);
    expect(getDeletedTasks()).toHaveLength(1);
  });
});

describe("markOrphanedTodoistTasksDeleted — edge cases", () => {
  beforeEach(() => {
    getDb(); // ensure fresh schema
  });

  it("is a no-op when the DB has no Todoist-sourced tasks", () => {
    upsertTasks([
      { ...makeStoredTodoistTask("local-only"), todoistId: null, id: "local-only" },
    ]);
    const changed = markOrphanedTodoistTasksDeleted([]);
    expect(changed).toBe(0);
    expect(getAllTasks()).toHaveLength(1);
  });

  it("is idempotent — re-running does not re-stamp deleted_at", () => {
    upsertTasks([makeStoredTodoistTask("td-1")]);
    expect(markOrphanedTodoistTasksDeleted([])).toBe(1);

    const firstStamp = readRawTaskRow("td-1")?.deleted_at;
    expect(firstStamp).not.toBeNull();
    expect(firstStamp).not.toBeUndefined();

    // Second call sees deletedAt already non-null → WHERE clause excludes it.
    expect(markOrphanedTodoistTasksDeleted([])).toBe(0);
    expect(readRawTaskRow("td-1")?.deleted_at).toBe(firstStamp);
    expect(readRawTaskRow("td-1")?.deleted_source).toBe("sync");
  });

  it("survives the full lifecycle: orphan → restore in Todoist → orphan again", () => {
    upsertTasks([makeStoredTodoistTask("td-1")]);

    // Cycle 1: Todoist drops it.
    expect(markOrphanedTodoistTasksDeleted([])).toBe(1);
    expect(getAllTasks()).toHaveLength(0);

    // Cycle 2: Todoist returns it → upsert auto-restores.
    upsertTasks([makeStoredTodoistTask("td-1")]);
    expect(getAllTasks()).toHaveLength(1);

    // Cycle 3: Todoist drops it again → re-deletes.
    expect(markOrphanedTodoistTasksDeleted([])).toBe(1);
    expect(getAllTasks()).toHaveLength(0);
    // Sync-deleted rows are hidden from the trash dialog by design, but the
    // row itself still exists in the DB so auto-restore keeps working.
    expect(getDeletedTasks()).toHaveLength(0);
    expect(readRawTaskRow("td-1")?.deleted_source).toBe("sync");
  });
});
