/** Website request calls use the internal contract; all monitoring arrives in the one Ops.status() poll. */
import { WebsiteSyncRequestResultSchema, RequestSyncRequestSchema } from '@ziyixi/proto/website/sync/v1/sync_pb';
import type { WebsiteSyncRequestResult } from './api-types.ts';
import type { Env } from './env.ts';
import { callOps, conform, type OpsCall } from './ops-client.ts';
import { fromWire, toWire } from '@ziyixi/proto/wire-json';

export async function callWebsiteRequest(env: Env, requestId: string, lookup: boolean): Promise<OpsCall<WebsiteSyncRequestResult>> {
  const input = toWire(RequestSyncRequestSchema, fromWire(RequestSyncRequestSchema, { request_id: requestId }).message);
  return callOps(() => {
    if ((env.WEBSITE_SYNC as Env['WEBSITE_SYNC'] | undefined) === undefined) return Promise.reject(new Error('unavailable'));
    return lookup ? env.WEBSITE_SYNC.getSyncRequest(input) : env.WEBSITE_SYNC.requestSync(input);
  }, value => {
    const result = conform(WebsiteSyncRequestResultSchema, value);
    if (result === null || result.request_id !== requestId) return null;
    if (result.state === 'accepted' && (!result.run_id || !result.run_url)) return null;
    return result;
  });
}

export function unconfirmedWebsiteRequest(requestId: string, error = 'dispatch_unconfirmed'): WebsiteSyncRequestResult {
  return { request_id: requestId, state: 'unconfirmed', error_code: error };
}
