import { WorkerEntrypoint } from 'cloudflare:workers';
import { create } from '@ziyixi/proto/protobuf';
import { GuardLevel, Health, OpsStatusSchema, Severity } from '@ziyixi/proto/ops/v1/ops_pb';
import type * as wire from '@ziyixi/proto/ops/v1/ops_wire';
import { toWire } from '@ziyixi/proto/wire-json';
import type { Env } from './env.ts';

/** Read-only Home status. A quiet task list is healthy; no heartbeat or activity counters are written. */
export class Ops extends WorkerEntrypoint<Env> implements wire.OpsService {
  async status(): Promise<wire.OpsStatus> {
    const base = {
      version: 'ops-v1',
      app: 'tasks',
      generatedAt: new Date().toISOString(),
      modes: { maintenance: false },
      guard: { level: GuardLevel.NORMAL },
      capabilities: [],
      uiUrl: `https://${this.env.PUBLIC_HOST}/`,
    };
    try {
      const latest = await this.env.DB.prepare(
        'SELECT sequence,changed_at FROM changes ORDER BY sequence DESC LIMIT 1',
      ).first<{ sequence: number; changed_at: number }>();
      return toWire(
        OpsStatusSchema,
        create(OpsStatusSchema, {
          ...base,
          health: Health.OK,
          signals: [],
          counters: { database_ready: 1, change_sequence: latest?.sequence ?? 0 },
        }),
      );
    } catch {
      return toWire(
        OpsStatusSchema,
        create(OpsStatusSchema, {
          ...base,
          health: Health.DOWN,
          counters: {},
          signals: [{ code: 'status_unavailable', severity: Severity.CRITICAL }],
        }),
      );
    }
  }

  setGuard(): Promise<wire.GuardState> {
    return Promise.reject(new Error('invalid_input'));
  }
}
