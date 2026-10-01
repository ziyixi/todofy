/**
 * The D1 schema (../../../migrations) equals the container-era SQLite file's, column for column and in order, so
 * its rows import unchanged (../../../docs/design.md "Data migration"); 0002 only appends tasks.todoist_project_id
 * and 0003 drops four indexes no query needs (each cost one D1 row write per insert).
 * The live file's tasks table got description, deleted_at and deleted_source by ALTER TABLE, so they come last.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHarness, type Harness } from './harness.ts';

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(async () => {
  await h.dispose();
});

const COLUMNS: Record<string, string[]> = {
  time_entries: ['id', 'task_id', 'flow_date', 'start_time', 'end_time', 'duration_s', 'source', 'created_at'],
  tasks: [
    'id', 'todoist_id', 'title', 'project_name', 'project_color', 'priority', 'labels', 'estimated_mins', 'is_completed',
    'completed_at', 'due_date', 'created_at', 'synced_at', 'description', 'deleted_at', 'deleted_source',
    // 0002_incremental_sync.sql
    'todoist_project_id',
  ],
  settings: ['key', 'value'],
  flow_tasks: ['id', 'flow_date', 'task_id', 'sort_order'],
  completed_flow_tasks: ['id', 'flow_date', 'task_id'],
  flow_task_notes: ['id', 'task_id', 'flow_date', 'content', 'updated_at'],
  active_timer_session: [
    'id', 'task_id', 'flow_date', 'status', 'timer_mode', 'pomodoro_target_s', 'segment_wall_start', 'session_saved_s',
    'pomodoro_finished_task_id', 'pomodoro_finished_flow_date', 'pomodoro_finished_target_s', 'updated_at',
  ],
};

/** The container's ten named indexes minus the four 0003_fewer_task_indexes.sql drops. */
const INDEXES = [
  'idx_completed_flow_tasks_task_id',
  'idx_flow_task_notes_flow_date',
  'idx_flow_tasks_task_id',
  'idx_tasks_deleted_at',
  'idx_time_entries_flow_date',
  'idx_time_entries_task_id',
];

describe('schema', () => {
  it('has exactly the seven container-era tables, their columns in order', async () => {
    const tables = await h.sql<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name");
    expect(tables.map((table) => table.name)).toEqual(Object.keys(COLUMNS).sort());
    for (const [table, columns] of Object.entries(COLUMNS)) {
      const info = await h.sql<{ name: string }>(`PRAGMA table_info(${table})`);
      expect(info.map((column) => column.name), table).toEqual(columns);
    }
  });

  it('has the six remaining named indexes and the three unique pairs, no foreign keys and no triggers', async () => {
    const indexes = await h.sql<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name");
    expect(indexes.map((index) => index.name)).toEqual(INDEXES);
    const unique = await h.sql<{ tbl_name: string }>("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name LIKE 'sqlite_autoindex_%' ORDER BY name");
    // One key index per table, plus the UNIQUE pairs of flow_tasks, completed_flow_tasks and flow_task_notes.
    expect(unique).toHaveLength(7 + 3);
    expect(await h.sql("SELECT name FROM sqlite_master WHERE type = 'trigger'")).toEqual([]);
    for (const table of Object.keys(COLUMNS)) expect(await h.sql(`PRAGMA foreign_key_list(${table})`), table).toEqual([]);
  });

  it('every lookup by day, task or id still uses an index after 0003 (no full table scan)', async () => {
    const queries = [
      "SELECT task_id FROM flow_tasks WHERE flow_date = '2026-04-13'",
      "SELECT task_id FROM flow_tasks WHERE flow_date >= '2026-04-01' AND flow_date <= '2026-04-30'",
      "SELECT task_id FROM completed_flow_tasks WHERE flow_date = '2026-04-13'",
      "SELECT task_id FROM completed_flow_tasks WHERE flow_date >= '2026-04-01' AND flow_date <= '2026-04-30'",
      "SELECT id FROM tasks WHERE id IN (SELECT value FROM json_each('[\"a\",\"b\"]')) AND deleted_at IS NULL",
      'SELECT id FROM tasks WHERE deleted_at IS NULL',
    ];
    for (const query of queries) {
      const plan = await h.sql<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`);
      const details = plan.map((step) => step.detail).join(' | ');
      expect(details, query).toMatch(/USING (COVERING )?INDEX|USING INTEGER PRIMARY KEY|PRIMARY KEY/);
      expect(details, query).not.toMatch(/SCAN (flow_tasks|completed_flow_tasks|tasks)(?! USING)/);
    }
  });

  it('keeps the container-era column defaults', async () => {
    await h.sql("INSERT INTO tasks (id, title) VALUES ('d', 'Defaults')");
    await h.sql("INSERT INTO time_entries (id, task_id, flow_date, start_time) VALUES ('e', 'd', '2026-04-13', '2026-04-13T09:00:00Z')");
    expect(await h.sql('SELECT priority, labels, is_completed FROM tasks')).toEqual([{ priority: 1, labels: '[]', is_completed: 0 }]);
    const [entry] = await h.sql<{ source: string; created_at: string }>('SELECT source, created_at FROM time_entries');
    expect(entry?.source).toBe('timer');
    expect(entry?.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
