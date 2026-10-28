/**
 * Ops (contracts/ops-v1): Home's read-only view of the links app through its service binding, never a public route.
 * One D1 read of at most one row shows the database answers, and state.json gives the daily backup's facts
 * (ops-status.ts builds the answer). There is no guard: setGuard refuses, as for the other unguarded apps.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type * as wire from '@ziyixi/proto/ops/v1/ops_wire';
import { backupFacts } from './backup-runner.ts';
import { type Env, publicHost } from './env.ts';
import { linksStatus } from './ops-status.ts';

export class Ops extends WorkerEntrypoint<Env> implements wire.OpsService {
  async status(): Promise<wire.OpsStatus> {
    const now = Date.now();
    // The bucket not answering is a failed backup (backupFacts); D1 not answering is the app down.
    const [backup, database] = await Promise.all([
      backupFacts(this.env),
      this.env.DB.prepare('SELECT key FROM links LIMIT 1')
        .all()
        .then(
          () => true,
          () => false,
        ),
    ]);
    return linksStatus({ now, host: publicHost(this.env), database, backup });
  }

  setGuard(): Promise<wire.GuardState> {
    return Promise.reject(new Error('invalid_input'));
  }
}
