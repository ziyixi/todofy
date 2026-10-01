import { describe, expect, it, vi } from "vitest";

import type { WorkerState, Wrangler } from "../../scripts/release/cloudflare";
import type { DeploymentRow } from "../../scripts/release/github";
import {
  GateStateSchema,
  parsePayload,
  type GateState,
  type ReleasePayload,
} from "../../scripts/release/payload";
import {
  assertReleaseContext,
  buildPayload,
  checkBaseline,
  decide,
  deploy,
  gate,
  record,
  recover,
  rollback,
  upload,
  type GitHub,
  type ReleaseDeps,
} from "../../scripts/release/steps";
import { emptyContentRegistry } from "../../src/lib/content/registry";
import type { ContentManifest } from "../../src/lib/content/schema";

const SITE = "https://www.ziyixi.science";
const V1 = "11111111-1111-4111-8111-111111111111";
const V2 = "22222222-2222-4222-8222-222222222222";
const V3 = "33333333-3333-4333-8333-333333333333";
const identity = (codeSha: string, contentHash = "c".repeat(64)) => ({
  codeSha,
  contentHash,
  configHash: "b".repeat(64),
  schemaVersion: 1 as const,
});
const OLD = identity("d".repeat(40), "e".repeat(64));
const NEW = identity("a".repeat(40));
const contract = { canonicalOrigin: SITE, emptyStateText: "x", sourceMode: "notion", routes: [] };

function payload(overrides: Partial<ReleasePayload> = {}): ReleasePayload {
  return parsePayload({
    schemaVersion: 3,
    task: "website-release",
    operation: "release",
    identity: OLD,
    workerName: "ziyixi-website",
    workerVersionId: V1,
    previousWorkerVersionId: null,
    liveOrigin: null,
    workflowUrl: "https://github.com/ziyixi/todofy/actions/runs/1",
    contentRegistry: emptyContentRegistry(),
    verificationContract: contract,
    ...overrides,
  });
}

function row(id: number, body: unknown, minute: number): DeploymentRow {
  return { id, created_at: `2026-09-30T00:${String(minute).padStart(2, "0")}:00Z`, payload: body };
}

function fakeGitHub(
  records: { rows: DeploymentRow[]; states: Record<number, string> },
  legacy: { rows: DeploymentRow[]; states: Record<number, string> } = { rows: [], states: {} },
) {
  const setState = vi.fn(async () => undefined);
  const createRecord = vi.fn(async () => 99);
  const github: GitHub = {
    releaseRecords: async (repository?: string) => (repository ? legacy : records).rows,
    latestState: async (id, repository?: string) =>
      (repository ? legacy : records).states[Number(id)] ?? "missing",
    createRecord,
    setState,
  };
  return { github, setState, createRecord };
}

function fakeWorker(initial: string | null) {
  let active = initial;
  const worker: WorkerState = { activeVersion: async () => active };
  const wrangler: Wrangler = {
    firstDeploy: vi.fn(async () => {
      active = V3;
      return { versionId: V3 };
    }),
    uploadVersion: vi.fn(async () => ({ versionId: V2 })),
    deployVersion: vi.fn(async (versionId: string) => {
      active = versionId;
    }),
    deployTriggers: vi.fn(async () => undefined),
  };
  return {
    worker,
    wrangler,
    setActive: (value: string | null) => {
      active = value;
    },
  };
}

function deps(
  github: GitHub,
  cloudflare: ReturnType<typeof fakeWorker>,
  hostnames: string[] = ["www.ziyixi.science", "ziyixi.science"],
): ReleaseDeps {
  return {
    github,
    worker: cloudflare.worker,
    wrangler: cloudflare.wrangler,
    config: { name: "ziyixi-website", accountId: "f".repeat(32), hostnames },
    log: () => undefined,
  };
}

function releaseState(overrides: Partial<GateState["baseline"]> = {}): GateState {
  return GateStateSchema.parse({
    schemaVersion: 2,
    operation: "release",
    blocking: null,
    baseline: {
      deploymentId: "10",
      identity: OLD,
      workerVersionId: V1,
      liveOrigin: null,
      contentRegistry: emptyContentRegistry(),
      verificationContract: contract,
      ...overrides,
    },
  });
}

describe("release context", () => {
  const base = {
    operation: "release",
    confirmation: "release:www.ziyixi.science",
    allowEmpty: false,
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    siteUrl: SITE,
  };

  it("accepts a dispatch on main with the exact confirmation", () => {
    expect(assertReleaseContext(base)).toBe("release");
    // CI's Website deploy dispatches the workflow too; nothing calls it inline any more.
    expect(() => assertReleaseContext({ ...base, eventName: "push" })).toThrow(/dispatch/);
    expect(() => assertReleaseContext({ ...base, eventName: "workflow_call" })).toThrow(/dispatch/);
  });

  it("refuses a scheduled run: the schedule only dispatches the reconcile release", () => {
    for (const operation of ["release", "recovery", "bootstrap"]) {
      expect(() =>
        assertReleaseContext({
          ...base,
          eventName: "schedule",
          operation,
          confirmation: `${operation}:www.ziyixi.science`,
        }),
      ).toThrow(/only from a workflow dispatch/);
    }
  });

  it("requires the allow-empty suffix when the one-run switch is enabled", () => {
    expect(() => assertReleaseContext({ ...base, allowEmpty: true })).toThrow(
      "release:www.ziyixi.science:allow-empty",
    );
    expect(
      assertReleaseContext({
        ...base,
        allowEmpty: true,
        confirmation: "release:www.ziyixi.science:allow-empty",
      }),
    ).toBe("release");
  });

  it("refuses other refs, events, operations and confirmations", () => {
    expect(() => assertReleaseContext({ ...base, ref: "refs/heads/feature" })).toThrow(/main/);
    expect(() => assertReleaseContext({ ...base, eventName: "pull_request" })).toThrow(/dispatch/);
    expect(() => assertReleaseContext({ ...base, operation: "status" })).toThrow(/Unsupported/);
    expect(() => assertReleaseContext({ ...base, confirmation: "release" })).toThrow(/exactly/);
    expect(() =>
      assertReleaseContext({
        ...base,
        operation: "bootstrap",
        allowEmpty: true,
        confirmation: "bootstrap:www.ziyixi.science:allow-empty",
      }),
    ).toThrow(/not valid for bootstrap/);
  });
});

describe("release gate", () => {
  it("asks for a bootstrap instead of releasing when no record exists", async () => {
    const { github } = fakeGitHub({ rows: [], states: {} });
    await expect(
      gate(deps(github, fakeWorker(null)), { operation: "release", siteUrl: SITE }),
    ).resolves.toEqual({ bootstrapRequired: true });
  });

  it("uses the latest successful record as the baseline", async () => {
    const { github } = fakeGitHub({ rows: [row(10, payload(), 1)], states: { 10: "success" } });
    const result = await gate(deps(github, fakeWorker(V1)), {
      operation: "release",
      siteUrl: SITE,
    });
    expect(result).toMatchObject({
      bootstrapRequired: false,
      state: { baseline: { deploymentId: "10", workerVersionId: V1, identity: OLD } },
    });
  });

  it.each(["in_progress", "failure", "error", "missing"])(
    "blocks ordinary releases after a %s record",
    async (state) => {
      const { github } = fakeGitHub({ rows: [row(10, payload(), 1)], states: { 10: state } });
      await expect(
        gate(deps(github, fakeWorker(V1)), { operation: "release", siteUrl: SITE }),
      ).rejects.toThrow(/only recovery/);
    },
  );

  it("bootstraps from the legacy repository's last successful record", async () => {
    const legacyRegistry = {
      registryVersion: 1,
      articleCount: 0,
      posts: [],
    };
    const legacyPayload = {
      schemaVersion: 2,
      task: "website-release",
      identity: {
        codeSha: "1".repeat(40),
        contentHash: "2".repeat(64),
        configHash: "3".repeat(64),
        schemaVersion: 1,
      },
      contentRegistry: legacyRegistry,
      verificationContract: { canonicalOrigin: SITE, routes: [] },
      candidateDeploymentId: "dpl_x",
    };
    const { github } = fakeGitHub(
      { rows: [], states: {} },
      {
        rows: [row(7, JSON.stringify(legacyPayload), 2), row(6, legacyPayload, 1)],
        states: { 7: "failure", 6: "success" },
      },
    );
    const result = await gate(deps(github, fakeWorker(null)), {
      operation: "bootstrap",
      legacyRepository: "ziyixi/ziyixi.science",
      siteUrl: SITE,
    });
    expect(result).toMatchObject({
      state: {
        operation: "bootstrap",
        baseline: {
          deploymentId: "legacy:ziyixi/ziyixi.science#6",
          workerVersionId: null,
          contentRegistry: legacyRegistry,
        },
      },
    });
  });

  it("refuses bootstrap once records exist and an empty bootstrap without approval", async () => {
    const existing = fakeGitHub({ rows: [row(10, payload(), 1)], states: { 10: "success" } });
    await expect(
      gate(deps(existing.github, fakeWorker(V1)), { operation: "bootstrap", siteUrl: SITE }),
    ).rejects.toThrow(/no website-release record exists/);
    const empty = fakeGitHub({ rows: [], states: {} });
    await expect(
      gate(deps(empty.github, fakeWorker(null)), { operation: "bootstrap", siteUrl: SITE }),
    ).rejects.toThrow(/WEBSITE_BOOTSTRAP_APPROVAL/);
    await expect(
      gate(deps(empty.github, fakeWorker(null)), {
        operation: "bootstrap",
        siteUrl: SITE,
        bootstrapApproval: SITE,
      }),
    ).resolves.toMatchObject({ state: { baseline: { deploymentId: "empty" } } });
  });

  it("recovery also reconciles a successful latest record after a manual rollback", async () => {
    const latest = payload({ identity: NEW, workerVersionId: V2, previousWorkerVersionId: V1 });
    const { github, setState } = fakeGitHub({
      rows: [row(11, latest, 2), row(10, payload(), 1)],
      states: { 11: "success", 10: "success" },
    });
    const result = await gate(deps(github, fakeWorker(V1)), {
      operation: "recovery",
      siteUrl: SITE,
    });
    expect(result).toMatchObject({
      state: { blocking: { state: "success" }, baseline: { deploymentId: "10" } },
    });
    if (result.bootstrapRequired) throw new Error("unexpected");
    const next = await recover(deps(github, fakeWorker(V2)), result.state, {
      verifyRecorded: async () => undefined,
      logUrl: "u",
    });
    expect(setState).not.toHaveBeenCalled();
    expect(next.baseline.workerVersionId).toBe(V2);
  });

  it("recovery carries the blocked record and the earlier successful baseline", async () => {
    const blocked = payload({ identity: NEW, workerVersionId: V2, previousWorkerVersionId: V1 });
    const { github } = fakeGitHub({
      rows: [row(11, blocked, 2), row(10, payload(), 1)],
      states: { 11: "error", 10: "success" },
    });
    const result = await gate(deps(github, fakeWorker(V2)), {
      operation: "recovery",
      siteUrl: SITE,
    });
    expect(result).toMatchObject({
      state: {
        blocking: { deploymentId: "11", state: "error" },
        baseline: { deploymentId: "10", workerVersionId: V1 },
      },
    });
  });
});

describe("deployment decision", () => {
  it("skips an unchanged identity and deploys changed, forced and non-release runs", () => {
    const state = releaseState();
    expect(decide({ operation: "release", forceBuild: false, expected: OLD, state })).toEqual({
      deployRequired: false,
      reason: "identity-unchanged",
    });
    expect(decide({ operation: "release", forceBuild: false, expected: NEW, state })).toMatchObject(
      {
        deployRequired: true,
      },
    );
    expect(decide({ operation: "release", forceBuild: true, expected: OLD, state })).toMatchObject({
      reason: "explicit-force-build",
    });
    expect(
      decide({ operation: "recovery", forceBuild: false, expected: OLD, state }),
    ).toMatchObject({
      reason: "recovery-always-rebuilds",
    });
  });
});

describe("baseline check", () => {
  it("requires production to serve the recorded version and identity", async () => {
    const verify = vi.fn(async () => undefined);
    const { github } = fakeGitHub({ rows: [], states: {} });
    await checkBaseline(deps(github, fakeWorker(V1)), releaseState({ liveOrigin: SITE }), verify);
    expect(verify).toHaveBeenCalledWith(SITE, OLD);
    await expect(
      checkBaseline(deps(github, fakeWorker(V2)), releaseState(), verify),
    ).rejects.toThrow(/changed outside this workflow/);
  });
});

describe("upload, deploy and rollback", () => {
  it("uploads a version and deploys it after the stale and concurrency checks", async () => {
    const cloudflare = fakeWorker(V1);
    const { github } = fakeGitHub({ rows: [], states: {} });
    const d = deps(github, cloudflare);
    const uploaded = await upload(d, { state: releaseState(), identity: NEW });
    expect(uploaded).toEqual({ versionId: V2, firstDeploy: false, previousVersionId: V1 });
    await deploy(d, { upload: uploaded, identity: NEW });
    expect(cloudflare.wrangler.deployVersion).toHaveBeenCalledWith(V2, expect.any(String));
    expect(cloudflare.wrangler.deployTriggers).toHaveBeenCalledTimes(1);
  });

  it("refuses to upload or deploy when production changed meanwhile", async () => {
    const cloudflare = fakeWorker(V3);
    const { github } = fakeGitHub({ rows: [], states: {} });
    await expect(
      upload(deps(github, cloudflare), { state: releaseState(), identity: NEW }),
    ).rejects.toThrow(/changed during the release/);
    cloudflare.setActive(V3);
    await expect(
      deploy(deps(github, cloudflare), {
        upload: { versionId: V2, firstDeploy: false, previousVersionId: V1 },
        identity: NEW,
      }),
    ).rejects.toThrow(/changed during the release/);
    expect(cloudflare.wrangler.deployVersion).not.toHaveBeenCalled();
  });

  it("deploys its CI-green build when main has newer website code, so the next gate still passes", async () => {
    // A release built commit OLDER; meanwhile a website push landed (its own release is queued).
    const OLDER = identity("f".repeat(40));
    const records = {
      rows: [row(10, payload(), 1)],
      states: { 10: "success" } as Record<number, string>,
    };
    const { github, createRecord, setState } = fakeGitHub(records);
    const cloudflare = fakeWorker(V1);
    const d = deps(github, cloudflare);
    const uploaded = await upload(d, { state: releaseState(), identity: OLDER });
    await record(
      d,
      payload({ identity: OLDER, workerVersionId: V2, previousWorkerVersionId: V1 }),
      {
        ref: OLDER.codeSha,
        logUrl: "https://github.com/ziyixi/todofy/actions/runs/2",
      },
    );
    expect(createRecord).toHaveBeenCalledTimes(1);
    await deploy(d, { upload: uploaded, identity: OLDER });
    expect(cloudflare.wrangler.deployVersion).toHaveBeenCalledWith(V2, expect.any(String));
    // The run marks its record successful; the queued release's gate accepts it as the baseline.
    expect(setState).toHaveBeenCalledWith(99, "in_progress", expect.anything());
    records.rows.unshift(
      row(99, payload({ identity: OLDER, workerVersionId: V2, previousWorkerVersionId: V1 }), 2),
    );
    records.states[99] = "success";
    const next = await gate(d, { operation: "release", siteUrl: SITE });
    expect(next).toMatchObject({
      bootstrapRequired: false,
      state: { baseline: { deploymentId: "99" } },
    });
  });

  it("creates the Worker with its first deploy only for bootstrap", async () => {
    const { github } = fakeGitHub({ rows: [], states: {} });
    const bootstrap = GateStateSchema.parse({
      ...releaseState({ workerVersionId: null, identity: null, verificationContract: null }),
      operation: "bootstrap",
    });
    const cloudflare = fakeWorker(null);
    const uploaded = await upload(deps(github, cloudflare), { state: bootstrap, identity: NEW });
    expect(uploaded).toEqual({ versionId: V3, firstDeploy: true, previousVersionId: null });
    // Before any hostname exists there are no triggers to apply.
    await deploy(deps(github, cloudflare, []), { upload: uploaded, identity: NEW });
    expect(cloudflare.wrangler.deployVersion).not.toHaveBeenCalled();
    expect(cloudflare.wrangler.deployTriggers).not.toHaveBeenCalled();
    await expect(
      upload(deps(github, fakeWorker(null)), {
        state: releaseState({ workerVersionId: null }),
        identity: NEW,
      }),
    ).rejects.toThrow(/bootstrap/);
  });

  it("rolls back only from this release's own version", async () => {
    const { github } = fakeGitHub({ rows: [], states: {} });
    const uploaded = { versionId: V2, firstDeploy: false, previousVersionId: V1 };
    const cloudflare = fakeWorker(V2);
    const verifyIdentity = vi.fn(async () => undefined);
    const options = { message: "m", baseline: releaseState().baseline, verifyIdentity };
    await expect(
      rollback(deps(github, cloudflare), { ...options, upload: uploaded }),
    ).resolves.toBe(V1);
    expect(cloudflare.wrangler.deployVersion).toHaveBeenCalledWith(V1, "m");
    // A baseline without a live hostname (verified locally only) has nothing live to check.
    expect(verifyIdentity).not.toHaveBeenCalled();
    const concurrent = fakeWorker(V3);
    await expect(
      rollback(deps(github, concurrent), { ...options, upload: uploaded }),
    ).rejects.toThrow(/concurrent change/);
    await expect(
      rollback(deps(github, fakeWorker(V2)), {
        ...options,
        upload: { ...uploaded, previousVersionId: null },
      }),
    ).rejects.toThrow(/no recorded version/);
  });
});

// Run 36703886018: the release that first listed www failed at `wrangler triggers deploy` (www kept
// serving Vercel), restored the baseline, then checked it on www and recorded `error`. Its baseline was
// verified on the then preview host (website-preview.ziyixi.science, removed 2026-10-01); EARLIER stands
// for such a hostname that the baseline was recorded on before the canonical host was attached.
describe("attaching www after another hostname", () => {
  const EARLIER = "https://ziyixi.science";
  const HOSTS = ["ziyixi.science", "www.ziyixi.science"];
  const baselinePayload = payload({ liveOrigin: EARLIER });
  const failedPayload = payload({
    identity: NEW,
    workerVersionId: V2,
    previousWorkerVersionId: V1,
    liveOrigin: SITE,
  });

  it("verifies a rollback where the baseline was verified, not on the hostname being added", async () => {
    const { github } = fakeGitHub({ rows: [], states: {} });
    const cloudflare = fakeWorker(V1);
    vi.mocked(cloudflare.wrangler.deployTriggers).mockRejectedValueOnce(
      new Error("already has externally managed DNS records"),
    );
    const d = deps(github, cloudflare, HOSTS);
    const state = releaseState({ liveOrigin: EARLIER });
    const uploaded = await upload(d, { state, identity: NEW });
    await expect(deploy(d, { upload: uploaded, identity: NEW })).rejects.toThrow(/externally/);
    // www serves Vercel: only a check there would fail.
    const verifyIdentity = vi.fn(async (origin: string) => {
      if (origin === SITE) throw new Error("identity mismatch");
    });
    await expect(
      rollback(d, { upload: uploaded, message: "m", baseline: state.baseline, verifyIdentity }),
    ).resolves.toBe(V1);
    expect(verifyIdentity.mock.calls).toEqual([[EARLIER, OLD]]);
  });

  it("still verifies when production already serves the baseline, and reports a failed check", async () => {
    const { github } = fakeGitHub({ rows: [], states: {} });
    const uploaded = { versionId: V2, firstDeploy: false, previousVersionId: V1 };
    const baseline = releaseState({ liveOrigin: EARLIER }).baseline;
    const verifyIdentity = vi.fn(async () => undefined);
    await rollback(deps(github, fakeWorker(V1), HOSTS), {
      upload: uploaded,
      message: "m",
      baseline,
      verifyIdentity,
    });
    expect(verifyIdentity).toHaveBeenCalledWith(EARLIER, OLD);
    await expect(
      rollback(deps(github, fakeWorker(V2), HOSTS), {
        upload: uploaded,
        message: "m",
        baseline,
        verifyIdentity: async () => {
          throw new Error("does not serve the expected build identity");
        },
      }),
    ).rejects.toThrow(/expected build identity/);
  });

  it("needs recovery after the errored record, which re-verifies the earlier baseline and attaches www", async () => {
    const records = {
      rows: [row(11, failedPayload, 2), row(10, baselinePayload, 1)],
      states: { 11: "error", 10: "success" } as Record<number, string>,
    };
    const { github, setState } = fakeGitHub(records);
    const cloudflare = fakeWorker(V1);
    const d = deps(github, cloudflare, HOSTS);
    // The push-dispatched release (and every relay release) stops at the gate.
    await expect(gate(d, { operation: "release", siteUrl: SITE })).rejects.toThrow(
      /state is error; only recovery/,
    );
    const result = await gate(d, { operation: "recovery", siteUrl: SITE });
    if (result.bootstrapRequired) throw new Error("unexpected");
    const verifyRecorded = vi.fn(async () => undefined);
    const state = await recover(d, result.state, { verifyRecorded, logUrl: "u" });
    expect(verifyRecorded).toHaveBeenCalledWith(
      expect.objectContaining({ liveOrigin: EARLIER, identity: OLD }),
    );
    expect(setState).not.toHaveBeenCalled();
    const uploaded = await upload(d, { state, identity: NEW });
    expect(uploaded).toMatchObject({ firstDeploy: false, previousVersionId: V1 });
    await deploy(d, { upload: uploaded, identity: NEW });
    expect(cloudflare.wrangler.deployTriggers).toHaveBeenCalledTimes(1);
  });

  it("refuses releases and recovery once www stops serving the Worker after it was recorded", async () => {
    // www detached by hand: the recorded live hostname is www, never the earlier hostname.
    const attached = payload({
      workerVersionId: V2,
      previousWorkerVersionId: V1,
      liveOrigin: SITE,
    });
    const { github } = fakeGitHub({
      rows: [row(12, attached, 3), row(10, baselinePayload, 1)],
      states: { 12: "success", 10: "success" },
    });
    const d = deps(github, fakeWorker(V2), ["ziyixi.science"]);
    const verify = vi.fn(async (origin: string) => {
      if (origin === SITE) throw new Error("identity mismatch");
    });
    const released = await gate(d, { operation: "release", siteUrl: SITE });
    if (released.bootstrapRequired) throw new Error("unexpected");
    await expect(checkBaseline(d, released.state, verify)).rejects.toThrow(/mismatch/);
    const recovering = await gate(d, { operation: "recovery", siteUrl: SITE });
    if (recovering.bootstrapRequired) throw new Error("unexpected");
    await expect(
      recover(d, recovering.state, {
        verifyRecorded: (recorded) => verify(recorded.liveOrigin ?? ""),
        logUrl: "u",
      }),
    ).rejects.toThrow(/mismatch/);
    expect(verify).not.toHaveBeenCalledWith(EARLIER, expect.anything());
  });
});

describe("recovery", () => {
  const blocked = payload({ identity: NEW, workerVersionId: V2, previousWorkerVersionId: V1 });
  const state = GateStateSchema.parse({
    ...releaseState(),
    operation: "recovery",
    blocking: { deploymentId: "11", state: "error", payload: blocked },
  });

  it("re-verifies a live blocked version and records it as the new baseline", async () => {
    const { github, setState } = fakeGitHub({ rows: [], states: {} });
    const verifyRecorded = vi.fn(async () => undefined);
    const next = await recover(deps(github, fakeWorker(V2)), state, {
      verifyRecorded,
      logUrl: "u",
    });
    expect(verifyRecorded).toHaveBeenCalledWith(blocked);
    expect(setState).toHaveBeenCalledWith("11", "success", expect.anything());
    expect(next.baseline).toMatchObject({ deploymentId: "11", workerVersionId: V2 });
  });

  it("keeps the baseline when production still serves it, and refuses anything else", async () => {
    const { github, setState } = fakeGitHub({ rows: [], states: {} });
    const verifyRecorded = vi.fn(async () => undefined);
    await expect(
      recover(deps(github, fakeWorker(V1)), state, { verifyRecorded, logUrl: "u" }),
    ).resolves.toEqual(state);
    expect(setState).not.toHaveBeenCalled();
    await expect(
      recover(deps(github, fakeWorker(V3)), state, { verifyRecorded, logUrl: "u" }),
    ).rejects.toThrow(/neither the blocked nor the baseline/);
  });
});

describe("release record payload", () => {
  const manifest = {
    sourceMode: "notion",
    routes: [{ path: "/", expectedStatus: 200, kind: "page" }],
    candidateRegistry: emptyContentRegistry(),
  } as unknown as ContentManifest;

  it("records the uploaded version, its predecessor and the live hostname", () => {
    const built = buildPayload({
      operation: "release",
      identity: NEW,
      upload: { versionId: V2, firstDeploy: false, previousVersionId: V1 },
      config: { name: "ziyixi-website", accountId: "f".repeat(32), hostnames: [] },
      liveOrigin: "https://www.ziyixi.science",
      workflowUrl: "https://github.com/ziyixi/todofy/actions/runs/2",
      registry: emptyContentRegistry(),
      manifest,
      canonicalOrigin: SITE,
    });
    expect(built).toMatchObject({
      schemaVersion: 3,
      workerVersionId: V2,
      previousWorkerVersionId: V1,
      liveOrigin: "https://www.ziyixi.science",
      verificationContract: { canonicalOrigin: SITE, sourceMode: "notion" },
    });
  });

  it("refuses fixture content and a registry that differs from the manifest", () => {
    const base = {
      operation: "release" as const,
      identity: NEW,
      upload: { versionId: V2, firstDeploy: false, previousVersionId: V1 },
      config: { name: "ziyixi-website", accountId: "f".repeat(32), hostnames: [] },
      liveOrigin: null,
      workflowUrl: "https://github.com/ziyixi/todofy/actions/runs/2",
      registry: emptyContentRegistry(),
      canonicalOrigin: SITE,
    };
    expect(() =>
      buildPayload({
        ...base,
        manifest: { ...manifest, sourceMode: "fixture" } as ContentManifest,
      }),
    ).toThrow(/Fixture/);
    expect(() =>
      buildPayload({ ...base, registry: { ...emptyContentRegistry(), articleCount: 1 }, manifest }),
    ).toThrow();
  });
});
