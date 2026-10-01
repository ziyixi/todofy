/**
 * D1 through drizzle-orm/d1, with a meter that adds up what D1 itself reports per statement (meta.rows_written
 * and meta.rows_read). D1's daily Free allowance is shared by every Worker on the account, so each request logs
 * its row counts and the workerd tests assert them (../../docs/design.md "Write budget").
 *
 * The meter wraps the binding: run(), all() and batch() report meta; first() and raw() do not, so writes always
 * go through run() or a batch (drizzle uses run() for insert, update and delete without returning()).
 */
import type { SQL } from 'drizzle-orm';
import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { SQLiteAsyncDialect } from 'drizzle-orm/sqlite-core';

/** drizzle without a relational schema: the query builder only (no per-request relational config to build). */
export type Db = DrizzleD1Database & { $client: D1Database };

export class Meter {
  rowsWritten = 0;
  rowsRead = 0;

  record(result: D1Result | D1Response): void {
    const meta = result.meta as Partial<D1Meta> | undefined;
    this.rowsWritten += typeof meta?.rows_written === 'number' ? meta.rows_written : 0;
    this.rowsRead += typeof meta?.rows_read === 'number' ? meta.rows_read : 0;
  }
}

class MeteredStatement {
  readonly inner: D1PreparedStatement;
  private readonly meter: Meter;

  constructor(inner: D1PreparedStatement, meter: Meter) {
    this.inner = inner;
    this.meter = meter;
  }

  bind(...values: unknown[]): MeteredStatement {
    return new MeteredStatement(this.inner.bind(...values), this.meter);
  }

  first(column?: string): Promise<unknown> {
    return column === undefined ? this.inner.first() : this.inner.first(column);
  }

  async run(): Promise<D1Result> {
    const result = await this.inner.run();
    this.meter.record(result);
    return result;
  }

  async all(): Promise<D1Result> {
    const result = await this.inner.all();
    this.meter.record(result);
    return result;
  }

  raw(options?: { columnNames?: boolean }): Promise<unknown[]> {
    return options?.columnNames === true ? this.inner.raw({ columnNames: true }) : this.inner.raw();
  }
}

class MeteredDatabase {
  private readonly inner: D1Database;
  private readonly meter: Meter;

  constructor(inner: D1Database, meter: Meter) {
    this.inner = inner;
    this.meter = meter;
  }

  prepare(query: string): MeteredStatement {
    return new MeteredStatement(this.inner.prepare(query), this.meter);
  }

  async batch(statements: MeteredStatement[]): Promise<D1Result[]> {
    const results = await this.inner.batch(statements.map((statement) => statement.inner));
    for (const result of results) this.meter.record(result);
    return results;
  }

  exec(query: string): Promise<D1ExecResult> {
    return this.inner.exec(query);
  }
}

/** A metered binding: the same API as D1Database for prepare, batch and exec. */
export function meteredBinding(binding: D1Database, meter: Meter): D1Database {
  return new MeteredDatabase(binding, meter) as unknown as D1Database;
}

export function openDb(binding: D1Database, meter: Meter): Db {
  return drizzle(meteredBinding(binding, meter));
}

const dialect = new SQLiteAsyncDialect();

/**
 * Runs raw SQL statements as one atomic D1 batch through the metered binding and returns D1's results. (drizzle's
 * own batch() cannot take db.run(sql) items.) D1 counts each statement against its 50 queries per invocation.
 */
export async function batchSql(db: Db, statements: readonly SQL[]): Promise<D1Result[]> {
  if (statements.length === 0) return [];
  const prepared = statements.map((statement) => {
    const query = dialect.sqlToQuery(statement);
    return db.$client.prepare(query.sql).bind(...query.params);
  });
  return db.$client.batch(prepared);
}

/** SQLite's datetime('now') format (UTC, "YYYY-MM-DD HH:MM:SS"), the default of the created_at columns. */
export function sqliteNow(now: Date = new Date()): string {
  return now.toISOString().replace('T', ' ').slice(0, 19);
}
