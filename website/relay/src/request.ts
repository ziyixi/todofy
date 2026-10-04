import { fromWire, toWire } from "@ziyixi/proto/wire-json";
import {
  RequestSyncRequestSchema,
  WebsiteSyncRequestResultSchema,
} from "@ziyixi/proto/website/sync/v1/sync_pb";
import type { WebsiteSyncRequestResult } from "@ziyixi/proto/website/sync/v1/sync_wire";
import type { RelayEnv } from "./env";
import { dispatch, id, listRuns, object, releaseInputs, runUrl } from "./github";

function result(value: WebsiteSyncRequestResult): WebsiteSyncRequestResult {
  return toWire(
    WebsiteSyncRequestResultSchema,
    fromWire(WebsiteSyncRequestResultSchema, value, { strict: true }).message,
  );
}
export function requestIdentity(input: unknown): string {
  try {
    return fromWire(RequestSyncRequestSchema, input, { strict: true }).message.requestId;
  } catch {
    throw new Error("invalid_input");
  }
}
/** Home durably records the intent before this call. Uncertain intents use lookup only. */
export async function requestSync(
  env: RelayEnv,
  input: unknown,
  trigger: "manual" | "cron" = "manual",
): Promise<WebsiteSyncRequestResult> {
  const requestId = requestIdentity(input);
  if (!env.GITHUB_DISPATCH_TOKEN)
    return result({ request_id: requestId, state: "failed", error_code: "not_configured" });
  try {
    const response = await dispatch(
      env,
      releaseInputs(env, trigger, requestId),
      AbortSignal.timeout(8000),
    );
    if (response.status !== 200 && response.status !== 204) {
      return result({
        request_id: requestId,
        state: response.status >= 500 || response.status === 408 ? "unconfirmed" : "failed",
        error_code: response.status === 403 ? "github_permission_denied" : "github_dispatch_failed",
      });
    }
    if (response.status === 200) {
      const runId = object(await response.json())?.workflow_run_id;
      if (id(runId))
        return result({
          request_id: requestId,
          state: "accepted",
          run_id: String(runId),
          run_url: runUrl(env, runId),
        });
    }
  } catch {
    /* The dispatch may have been accepted. Never send it again. */
  }
  return result({
    request_id: requestId,
    state: "unconfirmed",
    error_code: "github_dispatch_unconfirmed",
  });
}
export async function getSyncRequest(
  env: RelayEnv,
  input: unknown,
): Promise<WebsiteSyncRequestResult> {
  const requestId = requestIdentity(input);
  if (!env.GITHUB_DISPATCH_TOKEN)
    return result({ request_id: requestId, state: "unconfirmed", error_code: "not_configured" });
  try {
    const match = (await listRuns(env, AbortSignal.timeout(8000))).find(
      (run) => run.requestId === requestId,
    );
    if (match)
      return result({
        request_id: requestId,
        state: "accepted",
        run_id: String(match.id),
        run_url: runUrl(env, match.id),
      });
  } catch {
    return result({
      request_id: requestId,
      state: "unconfirmed",
      error_code: "github_unavailable",
    });
  }
  return result({
    request_id: requestId,
    state: "unconfirmed",
    error_code: "github_dispatch_unconfirmed",
  });
}
