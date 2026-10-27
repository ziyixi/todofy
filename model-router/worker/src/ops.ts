import { WorkerEntrypoint } from 'cloudflare:workers';
import { create } from '@ziyixi/proto/protobuf';
import { toWire } from '@ziyixi/proto/wire-json';
import { OpsStatusSchema, GuardStateSchema, GuardLevel, Health, Severity } from '@ziyixi/proto/ops/v1/ops_pb';
import type * as wire from '@ziyixi/proto/ops/v1/ops_wire';
import { DAY } from './store.ts';
import type { Env } from './types.ts';

export class Ops extends WorkerEntrypoint<Env> implements wire.OpsService {
  async status(): Promise<wire.OpsStatus> {
    const now = Date.now();
    const row = await this.env.DB.prepare(
      "SELECT count(*) AS requests, sum(state = 'succeeded') AS succeeded, sum(state IN ('failed','cancelled','interrupted')) AS failed, sum(state = 'running' AND started_ms < ?) AS stale FROM requests WHERE started_ms >= ?",
    )
      .bind(now - 15 * 60000, Math.floor(now / DAY) * DAY)
      .first<{ requests: number; succeeded: number; failed: number; stale: number }>();
    return toWire(
      OpsStatusSchema,
      create(OpsStatusSchema, {
        version: 'ops-v1',
        app: 'model-router',
        generatedAt: new Date(now).toISOString(),
        uiUrl: `https://${this.env.PUBLIC_HOST}/`,
        health: row?.stale ? Health.DEGRADED : Health.OK,
        capabilities: [],
        modes: { maintenance: false },
        guard: { level: GuardLevel.NORMAL },
        counters: {
          requests_today: row?.requests ?? 0,
          succeeded_today: row?.succeeded ?? 0,
          failed_today: row?.failed ?? 0,
          interrupted: row?.stale ?? 0,
        },
        signals: row?.stale
          ? [{ code: 'model_execution_unknown', severity: Severity.WARNING, metrics: { count: row.stale } }]
          : [],
      }),
    );
  }
  setGuard(input: wire.SetGuardInput): Promise<wire.GuardState> {
    if (input.level !== 'normal') throw new Error('invalid_input');
    return Promise.resolve(toWire(GuardStateSchema, create(GuardStateSchema, { level: GuardLevel.NORMAL })));
  }
}
