import { fromWire, toWire } from "@ziyixi/proto/wire-json";
import { OpsStatusSchema } from "@ziyixi/proto/ops/v1/ops_pb";
import type { OpsStatus } from "@ziyixi/proto/ops/v1/ops_wire";
import { WebsiteSyncStatusSchema } from "@ziyixi/proto/website/sync/v1/sync_pb";
import type {
  WebsiteSyncAttempt,
  WebsiteSyncStatus,
} from "@ziyixi/proto/website/sync/v1/sync_wire";
import type { RelayEnv } from "./env";
import {
  ACTIVE_STATUSES,
  githubJson,
  id,
  listRuns,
  object,
  runUrl,
  utc,
  type RunSummary,
} from "./github";

interface Receipt {
  deploymentId: number;
  runId: number;
  attempt: number;
  checkedAt: string | null;
  decision: "changed" | "unchanged" | "not_checked";
}
/** A receipt with its deployment's latest status, which only a displayed run needs. */
interface SettledReceipt extends Receipt {
  state: string;
  code: string;
}
interface Release {
  identity: Record<string, unknown>;
  version: string;
  runId: string;
  verifiedAt: string;
}
// Runs leave the shared release lock in queue order, so the latest and any active run sit at the
// top of the listing; ten runs (~110 KiB of JSON) leave room for cancelled queued runs above them.
const STATUS_RUN_PAGE = 10;
const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODES = new Set([
  "sync_deploying",
  "sync_unchanged",
  "sync_published",
  "sync_bootstrap_required",
  "sync_gate_blocked",
  "sync_check_failed",
  "sync_build_failed",
  "sync_publish_failed",
  "sync_cancelled",
  "sync_receipt_failed",
]);

export function nextCheck(env: RelayEnv, now: Date): string {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(env.DAILY_SYNC_CRON);
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23)
    throw new Error("invalid_configuration");
  const next = new Date(now);
  next.setUTCHours(Number(match[2]), Number(match[1]), 0, 0);
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}
async function deployments(
  env: RelayEnv,
  task: string,
  environment: string,
  limit: number,
  signal: AbortSignal,
): Promise<(Record<string, unknown> & { id: number })[]> {
  const rows = await githubJson(
    env,
    `/deployments?task=${task}&environment=${environment}&per_page=${limit}`,
    signal,
  );
  if (!Array.isArray(rows) || rows.length > limit) throw new Error("github_response_invalid");
  return rows
    .map(object)
    .filter((row): row is Record<string, unknown> & { id: number } => !!row && id(row.id));
}
async function latestState(
  env: RelayEnv,
  deploymentId: unknown,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const states = await githubJson(env, `/deployments/${deploymentId}/statuses?per_page=1`, signal);
  if (!Array.isArray(states)) throw new Error("github_response_invalid");
  return object(states[0]) ?? { state: "missing" };
}
function buildIdentity(value: unknown): Record<string, unknown> | null {
  const identity = object(value);
  return identity &&
    typeof identity.codeSha === "string" &&
    SHA.test(identity.codeSha) &&
    typeof identity.contentHash === "string" &&
    /^[0-9a-f]{64}$/.test(identity.contentHash) &&
    typeof identity.configHash === "string" &&
    /^[0-9a-f]{64}$/.test(identity.configHash) &&
    Number.isSafeInteger(identity.schemaVersion) &&
    Number(identity.schemaVersion) > 0
    ? identity
    : null;
}
/** Validates every recent payload (fail closed) without fetching a status per receipt. */
async function receipts(env: RelayEnv, signal: AbortSignal): Promise<Receipt[]> {
  const rows = await deployments(env, "website-content-sync", "website-content-sync", 25, signal);
  const valid = rows.flatMap((row): Receipt[] => {
    const payload = object(row.payload);
    if (
      !payload ||
      payload.task !== "website-content-sync" ||
      payload.schema_version !== 1 ||
      !id(payload.run_id) ||
      !id(payload.run_attempt)
    )
      return [];
    const checkedAt = utc(payload.checked_at) ? payload.checked_at : null;
    const decision = payload.decision;
    if (decision !== "changed" && decision !== "unchanged" && decision !== "not_checked") return [];
    if (
      decision === "not_checked"
        ? payload.checked_at !== null || payload.identity !== null
        : !checkedAt || !buildIdentity(payload.identity)
    )
      throw new Error("github_response_invalid");
    if (
      typeof payload.request_id !== "string" ||
      (payload.request_id !== "" && !VERSION.test(payload.request_id))
    )
      throw new Error("github_response_invalid");
    return [
      {
        deploymentId: row.id,
        runId: payload.run_id,
        attempt: payload.run_attempt,
        checkedAt,
        decision,
      },
    ];
  });
  if (new Set(valid.map((row) => `${row.runId}:${row.attempt}`)).size !== valid.length)
    throw new Error("github_response_invalid");
  return valid;
}
/** Reads one receipt's latest deployment status; an unknown description is a missing receipt. */
async function settle(
  env: RelayEnv,
  receipt: Receipt,
  signal: AbortSignal,
): Promise<SettledReceipt> {
  const state = await latestState(env, receipt.deploymentId, signal);
  const code =
    typeof state.description === "string"
      ? state.description.toLowerCase()
      : "sync_receipt_missing";
  return {
    ...receipt,
    state: typeof state.state === "string" ? state.state : "missing",
    code: CODES.has(code) ? code : "sync_receipt_missing",
  };
}
/** Newest first, stopping at the first verified release: normally a single status read. */
async function lastRelease(env: RelayEnv, signal: AbortSignal): Promise<Release | null> {
  const rows = await deployments(env, "website-release", "production", 10, signal);
  for (const row of rows) {
    const payload = object(row.payload);
    const identity = buildIdentity(payload?.identity);
    if (
      !payload ||
      payload.task !== "website-release" ||
      payload.schemaVersion !== 3 ||
      !identity ||
      typeof identity.codeSha !== "string" ||
      !SHA.test(identity.codeSha) ||
      typeof payload.workerVersionId !== "string" ||
      !VERSION.test(payload.workerVersionId)
    )
      continue;
    const state = await latestState(env, row.id, signal);
    if (state.state !== "success" || !utc(state.created_at)) continue;
    const runId =
      typeof payload.workflowUrl === "string"
        ? /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/([1-9][0-9]*)$/.exec(
            payload.workflowUrl,
          )?.[1]
        : null;
    if (runId && payload.workflowUrl === runUrl(env, runId))
      return { identity, version: payload.workerVersionId, runId, verifiedAt: state.created_at };
  }
  return null;
}
function attempt(env: RelayEnv, run: RunSummary, receipt?: SettledReceipt): WebsiteSyncAttempt {
  let state: WebsiteSyncAttempt["state"];
  let code: string | undefined;
  if (ACTIVE_STATUSES.has(run.status))
    state =
      run.status === "in_progress" ? (receipt?.checkedAt ? "publishing" : "checking") : "queued";
  else if (run.conclusion === "cancelled") {
    state = "failed";
    code = "sync_cancelled";
  } else if (
    receipt?.state === "success" &&
    run.conclusion === "success" &&
    receipt.checkedAt &&
    ((receipt.decision === "unchanged" && receipt.code === "sync_unchanged") ||
      (receipt.decision === "changed" && receipt.code === "sync_published"))
  )
    state = receipt.decision === "unchanged" ? "unchanged" : "published";
  else if (receipt?.code === "sync_bootstrap_required" || receipt?.code === "sync_gate_blocked") {
    state = "blocked";
    code = receipt.code;
  } else if (
    run.conclusion === "failure" ||
    receipt?.state === "failure" ||
    receipt?.state === "error"
  ) {
    state = "failed";
    code = receipt?.code ?? "sync_check_failed";
  } else {
    state = "unconfirmed";
    code = "sync_receipt_missing";
  }
  return {
    run_id: String(run.id),
    run_url: runUrl(env, run.id),
    run_attempt: run.attempt,
    state,
    started_at: run.createdAt,
    ...(!ACTIVE_STATUSES.has(run.status) ? { completed_at: run.updatedAt } : {}),
    ...(code ? { error_code: code } : {}),
  };
}
/** The public site must serve the identity of the last verified release. */
async function observeWebsite(
  env: RelayEnv,
  release: Release,
  signal: AbortSignal,
): Promise<string | undefined> {
  try {
    const response = await fetch(`https://${env.CANONICAL_HOST}/build-info.json`, {
      signal,
      redirect: "manual",
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) return "website_observation_failed";
    const body = await response.text();
    const identity = body.length <= 16_384 ? object(JSON.parse(body)) : null;
    return !identity ||
      ["codeSha", "contentHash", "configHash", "schemaVersion"].some(
        (key) => identity[key] !== release.identity[key],
      )
      ? "website_identity_mismatch"
      : undefined;
  } catch {
    return "website_observation_failed";
  }
}
/** One bounded observation: a green workflow cannot stand in for a missing content receipt. */
export async function getSyncStatus(env: RelayEnv, now = new Date()): Promise<WebsiteSyncStatus> {
  const base = { observed_at: now.toISOString(), next_check_at: nextCheck(env, now) };
  if (!env.GITHUB_DISPATCH_TOKEN) return { ...base, error_code: "not_configured" };
  try {
    const signal = AbortSignal.timeout(8000);
    const [runs, checks, release] = await Promise.all([
      listRuns(env, STATUS_RUN_PAGE, signal),
      receipts(env, signal),
      lastRelease(env, signal),
    ]);
    // Only the latest and active runs show a receipt state: at most two status reads.
    const receiptOf = (run?: RunSummary) => {
      const receipt = run && checks.find((r) => r.runId === run.id && r.attempt === run.attempt);
      return receipt ? settle(env, receipt, signal) : undefined;
    };
    const latest = runs[0];
    const active = runs.find((run) => ACTIVE_STATUSES.has(run.status));
    const latestReceipt = receiptOf(latest);
    const [latestSettled, activeSettled, websiteError] = await Promise.all([
      latestReceipt,
      active === latest ? latestReceipt : receiptOf(active),
      release ? observeWebsite(env, release, signal) : undefined,
    ]);
    const lastCheck = checks
      .filter((r) => r.checkedAt)
      .sort((a, b) => b.checkedAt!.localeCompare(a.checkedAt!))[0];
    const value: WebsiteSyncStatus = {
      ...base,
      ...(latest ? { latest_attempt: attempt(env, latest, latestSettled) } : {}),
      ...(lastCheck?.checkedAt
        ? {
            last_check: {
              checked_at: lastCheck.checkedAt,
              decision: lastCheck.decision === "unchanged" ? "unchanged" : "deployment_required",
              run_id: String(lastCheck.runId),
              run_url: runUrl(env, lastCheck.runId),
            },
          }
        : {}),
      ...(release
        ? {
            last_publish: {
              verified_at: release.verifiedAt,
              worker_version_id: release.version,
              code_sha: String(release.identity.codeSha),
              run_id: release.runId,
              run_url: runUrl(env, release.runId),
            },
          }
        : {}),
      ...(active ? { active_run: attempt(env, active, activeSettled) } : {}),
      ...(websiteError ? { error_code: websiteError } : {}),
    };
    return toWire(
      WebsiteSyncStatusSchema,
      fromWire(WebsiteSyncStatusSchema, value, { strict: true }).message,
    );
  } catch (error) {
    const code =
      error instanceof Error &&
      ["github_permission_denied", "github_response_invalid"].includes(error.message)
        ? error.message
        : "github_unavailable";
    return { ...base, error_code: code };
  }
}
export async function opsStatus(env: RelayEnv, now = new Date()): Promise<OpsStatus> {
  const sync = await getSyncStatus(env, now);
  const signals: OpsStatus["signals"][number][] = [];
  if (sync.error_code)
    signals.push({
      code: "website_sync_provider_unavailable",
      severity: "warning",
      metrics: {},
    });
  else {
    if (
      !sync.last_check ||
      now.getTime() - Date.parse(sync.last_check.checked_at) > 26 * 60 * 60 * 1000
    )
      signals.push({
        code: "website_sync_stale",
        severity: "warning",
        metrics: {},
        ...((sync.last_check?.checked_at ?? sync.latest_attempt?.started_at)
          ? { since: sync.last_check?.checked_at ?? sync.latest_attempt!.started_at }
          : {}),
      });
    const latest = sync.latest_attempt;
    if (latest && ["failed", "blocked", "unconfirmed"].includes(latest.state))
      signals.push({
        code:
          latest.state === "blocked"
            ? "website_sync_blocked"
            : latest.state === "unconfirmed"
              ? "website_sync_unconfirmed"
              : "website_sync_failed",
        severity: "warning",
        metrics: { run_id: Number(latest.run_id) },
        since: latest.started_at,
      });
  }
  const value: OpsStatus = {
    version: "ops-v1",
    app: "notion-publish",
    generated_at: sync.observed_at,
    health: sync.error_code ? "down" : signals.length ? "degraded" : "ok",
    modes: { maintenance: false },
    guard: { level: "normal", reason: null, until: null, set_at: null, deferred: [] },
    signals,
    counters: {},
    last_backup_at: null,
    ui_url: null,
    capabilities: [],
    website_sync: sync,
  };
  return toWire(OpsStatusSchema, fromWire(OpsStatusSchema, value, { strict: true }).message);
}
