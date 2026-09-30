import { z } from "zod";

import { PublicationIdentitySchema } from "../../src/lib/content/publication-state";
import { ContentRegistrySchema, ManifestRouteSchema } from "../../src/lib/content/schema";

/**
 * The GitHub Deployment record of one website release (task "website-release", environment
 * "production"). It is the release state across runs: the latest record's status gates the next
 * release, and the latest successful record is the baseline (its contentRegistry drives slug-change
 * redirects and the empty-collection guard; its Worker version is the rollback target).
 */
export const RELEASE_TASK = "website-release";
export const RELEASE_ENVIRONMENT = "production";
export const EMPTY_STATE_TEXT = "Writing will appear here.";

/** 60 KB per payload and 45 KB per registry, as before (GitHub stores the payload with the record). */
export const MAX_PAYLOAD_BYTES = 60_000;
export const MAX_REGISTRY_BYTES = 45_000;

export const OPERATIONS = ["release", "bootstrap", "recovery"] as const;
export type Operation = (typeof OPERATIONS)[number];

const HttpsOriginSchema = z
  .string()
  .regex(/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?$/, "expected an HTTPS origin without a path");

/** Cloudflare Worker version IDs are UUIDs. */
export const WorkerVersionIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

export const VerificationContractSchema = z
  .object({
    canonicalOrigin: HttpsOriginSchema,
    emptyStateText: z.string().min(1),
    sourceMode: z.enum(["empty", "notion"]),
    routes: z.array(ManifestRouteSchema),
  })
  .strict();

export type VerificationContract = z.infer<typeof VerificationContractSchema>;
export type BuildIdentity = z.infer<typeof PublicationIdentitySchema>;

export const ReleasePayloadSchema = z
  .object({
    schemaVersion: z.literal(3),
    task: z.literal(RELEASE_TASK),
    operation: z.enum(OPERATIONS),
    identity: PublicationIdentitySchema,
    workerName: z.string().regex(/^[a-z0-9-]+$/),
    workerVersionId: WorkerVersionIdSchema,
    previousWorkerVersionId: WorkerVersionIdSchema.nullable(),
    /** The hostname verified after deploy, or null while the Worker has none (docs/cutover.md). */
    liveOrigin: HttpsOriginSchema.nullable(),
    workflowUrl: z.string().url(),
    contentRegistry: ContentRegistrySchema,
    verificationContract: VerificationContractSchema,
  })
  .strict();

export type ReleasePayload = z.infer<typeof ReleasePayloadSchema>;

/**
 * The Vercel-era record (schemaVersion 2) in the old ziyixi/ziyixi.science repository. Only a
 * bootstrap reads it, to carry the content registry (slug history, feed GUIDs) into this repository.
 */
export const LegacyPayloadSchema = z
  .object({
    schemaVersion: z.literal(2),
    task: z.literal(RELEASE_TASK),
    identity: z
      .object({
        codeSha: z.string(),
        contentHash: z.string(),
        configHash: z.string(),
        schemaVersion: z.number(),
      })
      .strict(),
    contentRegistry: ContentRegistrySchema,
    verificationContract: z.object({ canonicalOrigin: HttpsOriginSchema }).passthrough(),
  })
  .passthrough();

/** What the gate hands to later steps (written to .generated/release/gate-state.json). */
export const GateStateSchema = z
  .object({
    schemaVersion: z.literal(2),
    operation: z.enum(OPERATIONS),
    /** The latest record when it blocks ordinary releases (recovery only). */
    blocking: z
      .object({
        deploymentId: z.string(),
        state: z.string(),
        payload: ReleasePayloadSchema,
      })
      .strict()
      .nullable(),
    /** The trusted baseline: the latest successful record, or a bootstrap source. */
    baseline: z
      .object({
        deploymentId: z.string(),
        identity: PublicationIdentitySchema.nullable(),
        workerVersionId: WorkerVersionIdSchema.nullable(),
        liveOrigin: HttpsOriginSchema.nullable(),
        contentRegistry: ContentRegistrySchema,
        verificationContract: VerificationContractSchema.nullable(),
      })
      .strict(),
  })
  .strict();

export type GateState = z.infer<typeof GateStateSchema>;

export function parsePayload(value: unknown): ReleasePayload {
  const payload = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  const parsed = ReleasePayloadSchema.parse(payload);
  assertPayloadSize(parsed);
  return parsed;
}

export function assertPayloadSize(payload: ReleasePayload): void {
  const registryBytes = Buffer.byteLength(JSON.stringify(payload.contentRegistry));
  if (registryBytes > MAX_REGISTRY_BYTES) {
    throw new Error(`The content registry exceeds the ${MAX_REGISTRY_BYTES}-byte payload budget.`);
  }
  const bytes = Buffer.byteLength(JSON.stringify(payload));
  if (bytes > MAX_PAYLOAD_BYTES) {
    throw new Error(`The release record payload exceeds ${MAX_PAYLOAD_BYTES} bytes.`);
  }
}

export function sameIdentity(left: BuildIdentity, right: BuildIdentity): boolean {
  return (
    left.codeSha === right.codeSha &&
    left.contentHash === right.contentHash &&
    left.configHash === right.configHash &&
    left.schemaVersion === right.schemaVersion
  );
}
