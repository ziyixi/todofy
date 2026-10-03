/** Read-only service binding adapters. Host metadata never crosses as business content. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type * as ops from '@ziyixi/proto/ops/v1/ops_wire';
import type { Env } from './env.ts';
import { OBJECT_NAME } from './state.ts';

export class Ops extends WorkerEntrypoint<Env> {
  async status(): Promise<ops.OpsStatus> {
    return this.env.FLEET.get(this.env.FLEET.idFromName(OBJECT_NAME)).status('fleet', Date.now());
  }
  setGuard(): never { throw new Error('invalid_input'); }
}

export class NewsletterOps extends WorkerEntrypoint<Env> {
  async status(): Promise<ops.OpsStatus> {
    return this.env.FLEET.get(this.env.FLEET.idFromName(OBJECT_NAME)).status('newsletter', Date.now());
  }
  setGuard(): never { throw new Error('invalid_input'); }
}
