import { beforeEach } from "vitest";
import path from "path";
import fs from "fs";

// Point the DB to an in-memory / temp path for tests
const TEST_DB_DIR = path.join(process.cwd(), "db");

beforeEach(() => {
  // Close the old SQLite connection before removing files
  const g = globalThis as unknown as {
    __flowdayDb?: unknown;
    __flowdaySqlite?: { close(): void };
  };
  if (g.__flowdaySqlite) {
    try { g.__flowdaySqlite.close(); } catch { /* already closed */ }
    delete g.__flowdaySqlite;
  }
  delete g.__flowdayDb;

  // Remove the test db before each test so getDb() creates a fresh one
  const dbPath = path.join(TEST_DB_DIR, "flowday.db");
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const p = dbPath + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
});
