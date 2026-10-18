import { stdout } from "node:process";
import { afterAll, beforeAll, expect, test } from "vitest";
import { getCatalog } from "../../src/catalog.ts";
import { startHarness, type Harness } from "./harness.ts";

let harness: Harness;
beforeAll(async () => {
  harness = await startHarness();
});
afterAll(async () => {
  await harness.dispose();
});

/** D1's own row metrics, including first() and each statement executed by batch(). */
function measuredReads(binding: D1Database) {
  const metrics = { statements: 0, rowsRead: 0, rowsWritten: 0 };
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function record<T>(result: D1Result<T>): D1Result<T> {
    metrics.statements++;
    metrics.rowsRead += result.meta.rows_read;
    metrics.rowsWritten += result.meta.rows_written;
    return result;
  }
  function wrap(statement: D1PreparedStatement): D1PreparedStatement {
    const counted = {
      bind: (...values: unknown[]) => wrap(statement.bind(...values)),
      all: async <T>() => record(await statement.all<T>()),
      first: async <T>(column?: string) => {
        const result = record(await statement.all());
        const row = result.results[0];
        return (column ? (row?.[column] ?? null) : (row ?? null)) as T | null;
      },
    } as unknown as D1PreparedStatement;
    originals.set(counted, statement);
    return counted;
  }
  const db = {
    prepare: (sql: string) => wrap(binding.prepare(sql)),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      const results = await binding.batch<T>(
        statements.map((statement) => originals.get(statement) ?? statement),
      );
      return results.map(record);
    },
  } as unknown as D1Database;
  return { db, metrics };
}
async function addTasks(prefix: string, count: number, completed: boolean) {
  const data = Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-${String(index)}`,
    order: index,
  }));
  await harness.db
    .prepare(
      `INSERT INTO tasks(id,title,project_id,completed,due_date,sort_order,created_at,updated_at)
    SELECT value->>'id','Synthetic catalog budget task','budget-project',?,CASE WHEN ?=0 THEN '2030-04-15' ELSE '' END,value->>'order',1,1 FROM json_each(?)`,
    )
    .bind(Number(completed), Number(completed), JSON.stringify(data))
    .run();
}

test("catalog row-read budget with a personal active list and completed history", async () => {
  await harness.db
    .prepare(
      "INSERT INTO projects(id,title,created_at,updated_at) VALUES('budget-project','Synthetic budget project',1,1),('empty-project','Synthetic empty project',1,1)",
    )
    .run();
  await addTasks("active", 40, false);
  await addTasks("history-before", 2000, true);
  const measured = measuredReads(harness.db);
  const catalog = await getCatalog(
    measured.db,
    "America/Los_Angeles",
    Date.parse("2030-04-15T18:00:00Z"),
  );
  expect(
    catalog.taskCounts.find(
      (count) => count.view === "project" && count.id === "budget-project",
    )?.count,
  ).toBe(40);
  expect(
    catalog.taskCounts.find(
      (count) => count.view === "project" && count.id === "empty-project",
    )?.count,
  ).toBe(0);
  expect(measured.metrics.rowsWritten).toBe(0);
  stdout.write(
    JSON.stringify({
      event: "tasks_catalog_read_budget",
      active: 40,
      completed: 2000,
      ...measured.metrics,
    }) + "\n",
  );
});

test("metadata-only catalog reads never scan tasks and retain the full organization", async () => {
  const full = measuredReads(harness.db);
  const organization = await getCatalog(
    full.db,
    "America/Los_Angeles",
    Date.parse("2030-04-15T18:00:00Z"),
  );
  const basic = measuredReads(harness.db);
  const metadata = await getCatalog(
    basic.db,
    "America/Los_Angeles",
    Date.parse("2030-04-15T18:00:00Z"),
    false,
  );
  expect(metadata).toEqual({ ...organization, taskCounts: [] });
  expect(basic.metrics.statements).toBe(4);
  expect(basic.metrics.rowsWritten).toBe(0);
  expect(basic.metrics.rowsRead).toBeLessThan(20);
  stdout.write(
    JSON.stringify({
      event: "tasks_catalog_metadata_budget",
      active: 40,
      completed: 2000,
      ...basic.metrics,
    }) + "\n",
  );
});

test("catalog badge reads do not grow with completed label history", async () => {
  await harness.db
    .prepare(
      "INSERT INTO labels(id,title,created_at,updated_at) VALUES('budget-label','Synthetic budget label',1,1)",
    )
    .run();
  await harness.db
    .prepare("UPDATE tasks SET label_ids='[\"budget-label\"]'")
    .run();
  const before = measuredReads(harness.db);
  const first = await getCatalog(
    before.db,
    "America/Los_Angeles",
    Date.parse("2030-04-15T18:00:00Z"),
  );
  expect(
    first.taskCounts.find(
      (count) => count.view === "label" && count.id === "budget-label",
    )?.count,
  ).toBe(40);
  await addTasks("history-after", 2000, true);
  await harness.db
    .prepare(
      "UPDATE tasks SET label_ids='[\"budget-label\"]' WHERE id LIKE 'history-after-%'",
    )
    .run();
  const after = measuredReads(harness.db);
  const second = await getCatalog(
    after.db,
    "America/Los_Angeles",
    Date.parse("2030-04-15T18:00:00Z"),
  );
  expect(second.taskCounts).toEqual(first.taskCounts);
  stdout.write(
    JSON.stringify({
      event: "tasks_catalog_history_growth",
      active: 40,
      beforeCompleted: 2000,
      afterCompleted: 4000,
      before: before.metrics,
      after: after.metrics,
    }) + "\n",
  );
  expect(after.metrics.rowsWritten).toBe(0);
  expect(after.metrics.rowsRead).toBeLessThanOrEqual(
    before.metrics.rowsRead + 20,
  );
});
