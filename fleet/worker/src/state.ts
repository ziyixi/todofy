/** Single-host durable receipt ledger; atomic sequence admission and bounded metadata history. */
import { DurableObject } from 'cloudflare:workers';
import { FleetStatusSchema } from '@ziyixi/proto/fleet/ui/v1/fleet_ui_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import type * as ops from '@ziyixi/proto/ops/v1/ops_wire';
import type { Env } from './env.ts';
import { statusSnapshot } from './health.ts';
import { freshness, parseReport, reportCodes, ReceiptError, type Report } from './report.ts';
export const OBJECT_NAME = 'fleet-v1';

type Stored = { sequence: number; hash: string; received_at: number; report: string; codes: string };

export class FleetState extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS snapshot (
      id INTEGER PRIMARY KEY CHECK (id=1), epoch INTEGER NOT NULL, sequence INTEGER NOT NULL,
      hash TEXT NOT NULL, received_at INTEGER NOT NULL, report TEXT NOT NULL, codes TEXT NOT NULL
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS changes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, code TEXT NOT NULL
    )`);
  }

  private latest(): Stored | null {
    const rows = this.ctx.storage.sql.exec<Stored>(
      'SELECT sequence, hash, received_at, report, codes FROM snapshot WHERE id=1 AND epoch=?',
      Number(this.env.HOST_EPOCH),
    );
    return rows.toArray()[0] ?? null;
  }

  accept(text: string, hash: string, now: number): { accepted: boolean; sequence: number } {
    const report = parseReport(text, this.env.HOST_KEY, this.env.HOST_EPOCH, now);
    return this.ctx.storage.transactionSync(() => {
      const previous = this.latest();
      if (previous && report.sequence <= previous.sequence) {
        if (report.sequence === previous.sequence && hash === previous.hash) {
          return { accepted: false, sequence: report.sequence };
        }
        throw new ReceiptError('receipt_replay', 409);
      }
      this.trackChanges(previous, report, now);
      this.ctx.storage.sql.exec(`
        INSERT INTO snapshot(id,epoch,sequence,hash,received_at,report,codes) VALUES (1,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,sequence=excluded.sequence,
          hash=excluded.hash,received_at=excluded.received_at,report=excluded.report,codes=excluded.codes
      `,
      report.epoch,
      report.sequence,
      hash,
      now,
      JSON.stringify(report),
      JSON.stringify(reportCodes(report)));
      this.ctx.storage.sql.exec('DELETE FROM changes WHERE id <= (SELECT MAX(id)-256 FROM changes)');
      return { accepted: true, sequence: report.sequence };
    });
  }

  private trackChanges(previous: Stored | null, report: Report, now: number): void {
    const codes = reportCodes(report);
    const priorCodes: string[] = previous ? JSON.parse(previous.codes) as string[] : [];
    const added = codes.filter((code) => !priorCodes.includes(code));
    const resolved = priorCodes.filter((code) => !codes.includes(code));
    for (const code of added) {
      this.change(code, now);
    }
    for (const code of resolved) {
      this.change(`resolved_${code}`, now);
    }
    if (!previous) {
      this.change('first_receipt', now);
    }
  }

  private change(code: string, now: number): void {
    this.ctx.storage.sql.exec('INSERT INTO changes(at,code) VALUES (?,?)', now, code);
  }

  view(now: number): string {
    const doc = this.latest();
    const changes = this.ctx.storage.sql.exec<{ at: number; code: string }>(
      'SELECT at,code FROM changes ORDER BY id DESC LIMIT 32',
    ).toArray();
    const value = {
      name: 'fleetStatus',
      generate_time: new Date(now).toISOString(),
      freshness: freshness(doc?.received_at ?? null, now),
      ...(doc ? {
        receive_time: new Date(doc.received_at).toISOString(),
        report: JSON.parse(doc.report) as Report,
      } : {}),
      changes: changes.map((item) => ({
        observation_time: new Date(item.at).toISOString(),
        code: item.code,
      })),
      build_sha: this.env.BUILD_SHA ?? '',
    };
    const snapshot = fromWire(FleetStatusSchema, value, { strict: true }).message;
    return JSON.stringify(toWire(FleetStatusSchema, snapshot));
  }

  status(app: 'fleet' | 'newsletter', now: number): ops.OpsStatus {
    const doc = this.latest();
    const report: Report | null = doc ? JSON.parse(doc.report) as Report : null;
    return statusSnapshot(app, report, doc?.received_at ?? null, now, this.env.PUBLIC_HOST);
  }
}
