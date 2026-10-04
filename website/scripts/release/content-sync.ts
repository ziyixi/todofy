import { z } from "zod";

import { PublicationIdentitySchema } from "../../src/lib/content/publication-state";
import type { DeploymentState, GitHubClient } from "./github";

export const CONTENT_SYNC_TASK = "website-content-sync";
export const CONTENT_SYNC_ENVIRONMENT = "website-content-sync";
export const RequestIdSchema = z.union([z.literal(""), z.string().uuid()]);

const RunContextSchema = z.object({
  run_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  run_attempt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  request_id: RequestIdSchema,
});

/** Only a completed snapshot and decision can advance the last content-check time. */
export const ContentSyncCheckSchema = z
  .object({
    checked_at: z.iso.datetime(),
    decision: z.enum(["changed", "unchanged"]),
    identity: PublicationIdentitySchema.extend({ codeSha: z.string().regex(/^[a-f0-9]{40}$/) }),
  })
  .strict();
export type ContentSyncCheck = z.infer<typeof ContentSyncCheckSchema>;

export const ContentSyncPayloadSchema = RunContextSchema.extend({
  schema_version: z.literal(1),
  task: z.literal(CONTENT_SYNC_TASK),
  checked_at: z.iso.datetime().nullable(),
  decision: z.enum(["changed", "unchanged", "not_checked"]),
  identity: ContentSyncCheckSchema.shape.identity.nullable(),
})
  .strict()
  .refine(
    (value) =>
      value.decision === "not_checked"
        ? value.checked_at === null && value.identity === null
        : value.checked_at !== null && value.identity !== null,
    "A checked decision needs its actual check time and complete identity.",
  );
export type ContentSyncPayload = z.infer<typeof ContentSyncPayloadSchema>;

export function syncRunContext(environment: Record<string, string | undefined>) {
  return RunContextSchema.parse({
    run_id: Number(environment.GITHUB_RUN_ID),
    run_attempt: Number(environment.GITHUB_RUN_ATTEMPT),
    request_id: environment.RELEASE_REQUEST_ID ?? "",
  });
}

export function syncPayload(
  environment: Record<string, string | undefined>,
  check: ContentSyncCheck | null,
): ContentSyncPayload {
  return ContentSyncPayloadSchema.parse({
    schema_version: 1,
    task: CONTENT_SYNC_TASK,
    ...syncRunContext(environment),
    ...(check ?? { checked_at: null, decision: "not_checked", identity: null }),
  });
}

export interface SyncStages {
  job: string;
  gate: string;
  bootstrapRequired: boolean;
  receipt: string;
  build: string;
  artifact: string;
  liveVerified: boolean;
  releaseMarked: string;
}

/** Fixed descriptions are safe to expose in Home; no exception or Notion content enters a receipt. */
export function syncFinalStatus(
  payload: ContentSyncPayload,
  stages: SyncStages,
): { state: DeploymentState; description: string } {
  if (stages.job === "cancelled") return { state: "error", description: "SYNC_CANCELLED" };
  if (stages.bootstrapRequired) return { state: "error", description: "SYNC_BOOTSTRAP_REQUIRED" };
  if (stages.gate !== "success") return { state: "error", description: "SYNC_GATE_BLOCKED" };
  if (payload.decision === "not_checked")
    return { state: "failure", description: "SYNC_CHECK_FAILED" };
  if (stages.receipt !== "success") return { state: "failure", description: "SYNC_RECEIPT_FAILED" };
  if (payload.decision === "unchanged") {
    return stages.job === "success"
      ? { state: "success", description: "SYNC_UNCHANGED" }
      : { state: "failure", description: "SYNC_RECEIPT_FAILED" };
  }
  if (stages.build !== "success" || stages.artifact !== "success")
    return { state: "failure", description: "SYNC_BUILD_FAILED" };
  if (stages.job === "success" && stages.liveVerified && stages.releaseMarked === "success")
    return { state: "success", description: "SYNC_PUBLISHED" };
  return { state: "failure", description: "SYNC_PUBLISH_FAILED" };
}

/** Recover a lost create response by this run/attempt, without confusing the older release ledger. */
export async function ensureSyncRecord(
  github: Pick<GitHubClient, "contentSyncRecords" | "createContentSyncRecord">,
  payload: ContentSyncPayload,
  ref: string,
): Promise<number> {
  const matches = (await github.contentSyncRecords()).filter((row) => {
    const parsed = ContentSyncPayloadSchema.safeParse(row.payload);
    return (
      parsed.success &&
      parsed.data.run_id === payload.run_id &&
      parsed.data.run_attempt === payload.run_attempt
    );
  });
  if (matches.length > 1) throw new Error("This content-sync run has ambiguous receipt records.");
  if (matches[0]) {
    if (
      JSON.stringify(ContentSyncPayloadSchema.parse(matches[0].payload)) !== JSON.stringify(payload)
    )
      throw new Error("This content-sync run already has a different receipt payload.");
    return matches[0].id;
  }
  return github.createContentSyncRecord(payload, ref);
}
