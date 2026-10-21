/** Private service-binding read. No owner HTTP route or operation that refreshes a source. */
import { WorkerEntrypoint } from 'cloudflare:workers';
import type { HomeService, ReadHomeRequest, ReadHomeResponse } from '@ziyixi/proto/dashboard/mcp/v1/home_service_wire';
import { ReadHomeRequestSchema } from '@ziyixi/proto/dashboard/mcp/v1/home_service_pb';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';
import type { Env } from './env.ts';
import { HOME_OBJECT } from './state.ts';

export class HomeApi extends WorkerEntrypoint<Env> implements HomeService {
  async readHome(input: ReadHomeRequest): Promise<ReadHomeResponse> {
    let request: ReadHomeRequest;
    try { request = toWire(ReadHomeRequestSchema, fromWire(ReadHomeRequestSchema, input, { strict: true }).message); }
    catch { throw new Error('invalid_input'); }
    const stub = this.env.HOME.get(this.env.HOME.idFromName(HOME_OBJECT));
    return stub.readHome(request.after_occurrence_seq);
  }
}
