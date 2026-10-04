import { describe, expect, it, vi } from "vitest";

import {
  ContentSyncCheckSchema,
  ContentSyncPayloadSchema,
  ensureSyncRecord,
  syncFinalStatus,
  syncPayload,
  syncRunContext,
  type ContentSyncCheck,
  type SyncStages,
} from "../../scripts/release/content-sync";
import { GitHubClient } from "../../scripts/release/github";

const environment = {
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "2",
  RELEASE_REQUEST_ID: "11111111-1111-4111-8111-111111111111",
};
const identity = {
  codeSha: "a".repeat(40),
  contentHash: "b".repeat(64),
  configHash: "c".repeat(64),
  schemaVersion: 1 as const,
};
const checked: ContentSyncCheck = {
  checked_at: "2026-10-04T10:31:02.000Z",
  decision: "changed",
  identity,
};
const stages: SyncStages = {
  job: "success",
  gate: "success",
  bootstrapRequired: false,
  receipt: "success",
  build: "success",
  artifact: "success",
  liveVerified: true,
  releaseMarked: "success",
};

describe("content-sync receipt", () => {
  it("includes only run correlation, actual check time, decision and identity", () => {
    expect(syncPayload(environment, checked)).toEqual({
      schema_version: 1,
      task: "website-content-sync",
      run_id: 123,
      run_attempt: 2,
      request_id: environment.RELEASE_REQUEST_ID,
      ...checked,
    });
    expect(syncPayload(environment, null)).toEqual({
      schema_version: 1,
      task: "website-content-sync",
      run_id: 123,
      run_attempt: 2,
      request_id: environment.RELEASE_REQUEST_ID,
      checked_at: null,
      decision: "not_checked",
      identity: null,
    });
  });

  it("allows a blank request ID for direct Actions/code-push dispatches", () => {
    expect(syncRunContext({ ...environment, RELEASE_REQUEST_ID: "" }).request_id).toBe("");
  });

  it.each([
    { GITHUB_RUN_ID: "123x" },
    { GITHUB_RUN_ID: "0" },
    { GITHUB_RUN_ID: "9007199254740992" },
    { GITHUB_RUN_ATTEMPT: "-1" },
    { RELEASE_REQUEST_ID: "untrusted text" },
  ])("rejects invalid run correlation %j", (override) => {
    expect(() => syncRunContext({ ...environment, ...override })).toThrow();
  });

  it.each([
    { decision: "not_checked", checked_at: checked.checked_at },
    { checked_at: null },
    { identity: null },
    { checked_at: "not a date" },
    { identity: { ...identity, codeSha: "local-development" } },
    { contentRegistry: { posts: [] } },
    { article: "private content must never enter this ledger" },
  ])("rejects malformed or content-bearing payload %j", (override) => {
    expect(
      ContentSyncPayloadSchema.safeParse({ ...syncPayload(environment, checked), ...override })
        .success,
    ).toBe(false);
  });

  it("keeps a failed later build's actual check time", () => {
    const receipt = syncPayload(environment, checked);
    expect(syncFinalStatus(receipt, { ...stages, job: "failure", build: "failure" })).toEqual({
      state: "failure",
      description: "SYNC_BUILD_FAILED",
    });
    expect(receipt.checked_at).toBe(checked.checked_at);
    expect(receipt.identity).toEqual(identity);
  });

  it("does not label a failed receipt write as a build failure", () => {
    expect(
      syncFinalStatus(syncPayload(environment, checked), {
        ...stages,
        job: "failure",
        receipt: "failure",
        build: "skipped",
        artifact: "skipped",
      }),
    ).toEqual({ state: "failure", description: "SYNC_RECEIPT_FAILED" });
  });

  it("records unchanged success without requiring a build or live redeploy", () => {
    expect(
      syncFinalStatus(syncPayload(environment, { ...checked, decision: "unchanged" }), {
        ...stages,
        build: "skipped",
        artifact: "skipped",
        liveVerified: false,
        releaseMarked: "skipped",
      }),
    ).toEqual({ state: "success", description: "SYNC_UNCHANGED" });
  });

  it("reports bootstrap and failed gates without inventing a check", () => {
    const receipt = syncPayload(environment, null);
    expect(syncFinalStatus(receipt, { ...stages, bootstrapRequired: true })).toEqual({
      state: "error",
      description: "SYNC_BOOTSTRAP_REQUIRED",
    });
    expect(syncFinalStatus(receipt, { ...stages, gate: "failure" })).toEqual({
      state: "error",
      description: "SYNC_GATE_BLOCKED",
    });
    expect(syncFinalStatus(receipt, { ...stages, job: "failure" })).toEqual({
      state: "failure",
      description: "SYNC_CHECK_FAILED",
    });
    expect(receipt.checked_at).toBeNull();
  });

  it("only reports changed success after live verification and recording the release", () => {
    const receipt = syncPayload(environment, checked);
    expect(syncFinalStatus(receipt, stages)).toEqual({
      state: "success",
      description: "SYNC_PUBLISHED",
    });
    for (const override of [
      { liveVerified: false },
      { releaseMarked: "failure" },
      { job: "failure" },
    ]) {
      expect(syncFinalStatus(receipt, { ...stages, ...override })).toEqual({
        state: "failure",
        description: "SYNC_PUBLISH_FAILED",
      });
    }
  });

  it.each([null, checked])(
    "records cancellation truthfully with the check available at cancellation",
    (check) => {
      const receipt = syncPayload(environment, check);
      expect(syncFinalStatus(receipt, { ...stages, job: "cancelled" })).toEqual({
        state: "error",
        description: "SYNC_CANCELLED",
      });
      expect(receipt.checked_at).toBe(check?.checked_at ?? null);
    },
  );

  it("requires complete successful checks", () => {
    expect(() => ContentSyncCheckSchema.parse({ ...checked, decision: "not_checked" })).toThrow();
    expect(() => ContentSyncCheckSchema.parse({ ...checked, checked_at: null })).toThrow();
  });
});

describe("GitHub content-sync ledger", () => {
  it("uses its own task and non-production environment with bounded recovery reads", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ id: 42 }));
    const github = new GitHubClient({
      apiUrl: "https://api.github.com",
      repository: "owner/cloud",
      token: "fixture",
      fetchImpl,
    });
    const receipt = syncPayload(environment, checked);
    expect(await ensureSyncRecord(github, receipt, identity.codeSha)).toBe(42);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/owner/cloud/deployments?environment=website-content-sync&task=website-content-sync&per_page=25",
    );
    const posted = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(posted).toMatchObject({
      task: "website-content-sync",
      environment: "website-content-sync",
      production_environment: false,
      required_contexts: [],
      auto_merge: false,
      payload: receipt,
    });
  });

  it("recovers one lost create response without creating another record", async () => {
    const receipt = syncPayload(environment, checked);
    const createContentSyncRecord = vi.fn(async () => 99);
    const github = {
      contentSyncRecords: async () => [
        { id: 42, created_at: checked.checked_at, payload: receipt },
      ],
      createContentSyncRecord,
    };
    expect(await ensureSyncRecord(github, receipt, identity.codeSha)).toBe(42);
    expect(createContentSyncRecord).not.toHaveBeenCalled();
  });

  it("separates run attempts and refuses ambiguous or mismatched records", async () => {
    const receipt = syncPayload(environment, checked);
    const createContentSyncRecord = vi.fn(async () => 99);
    const row = { id: 42, created_at: checked.checked_at, payload: receipt };
    await expect(
      ensureSyncRecord(
        { contentSyncRecords: async () => [row, { ...row, id: 43 }], createContentSyncRecord },
        receipt,
        identity.codeSha,
      ),
    ).rejects.toThrow(/ambiguous/);
    await expect(
      ensureSyncRecord(
        { contentSyncRecords: async () => [row], createContentSyncRecord },
        { ...receipt, decision: "unchanged" },
        identity.codeSha,
      ),
    ).rejects.toThrow(/different/);
    expect(
      await ensureSyncRecord(
        {
          contentSyncRecords: async () => [{ ...row, payload: { ...receipt, run_attempt: 1 } }],
          createContentSyncRecord,
        },
        receipt,
        identity.codeSha,
      ),
    ).toBe(99);
  });

  it("leaves the release/rollback ledger filter unchanged", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json([]));
    const github = new GitHubClient({
      apiUrl: "https://api.github.com",
      repository: "owner/cloud",
      token: "fixture",
      fetchImpl,
    });
    await github.releaseRecords();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "https://api.github.com/repos/owner/cloud/deployments?environment=production&task=website-release&per_page=100&page=1",
    );
  });
});
