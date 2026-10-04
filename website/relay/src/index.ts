/// <reference types="@cloudflare/workers-types" />
import { WorkerEntrypoint } from "cloudflare:workers";
import type * as sync from "@ziyixi/proto/website/sync/v1/sync_wire";
import type { RelayEnv } from "./env";
import { getSyncRequest, requestSync } from "./request";
import { getSyncStatus, opsStatus } from "./status";

/** Same-account RPC only. The public HTTP path cannot request or inspect a sync. */
export class Ops extends WorkerEntrypoint<RelayEnv> implements sync.WebsiteSyncService {
  status() {
    return opsStatus(this.env);
  }
  getSyncStatus() {
    return getSyncStatus(this.env);
  }
  requestSync(input: sync.RequestSyncRequest) {
    return requestSync(this.env, input);
  }
  getSyncRequest(input: sync.GetSyncRequestRequest) {
    return getSyncRequest(this.env, input);
  }
}
async function runDailySync(env: RelayEnv): Promise<sync.WebsiteSyncRequestResult> {
  return requestSync(env, { request_id: crypto.randomUUID() }, "cron");
}
const worker = {
  fetch(): Response {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  },
  scheduled(_controller: ScheduledController, env: RelayEnv, context: ExecutionContext): void {
    context.waitUntil(
      runDailySync(env).then((result) => {
        console.log(
          JSON.stringify({
            relay: "daily_sync",
            state: result.state,
            run_id: result.run_id ?? null,
            error_code: result.error_code ?? null,
          }),
        );
      }),
    );
  },
};
export default worker;
