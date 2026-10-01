import { emptyContentRegistry } from "../../src/lib/content/registry";
import type { ContentManifest, ContentRegistry } from "../../src/lib/content/schema";
import type { WorkerState, Wrangler } from "./cloudflare";
import type { DeploymentRow, DeploymentState, GitHubClient } from "./github";
import {
  EMPTY_STATE_TEXT,
  GateStateSchema,
  LegacyPayloadSchema,
  parsePayload,
  ReleasePayloadSchema,
  sameIdentity,
  type BuildIdentity,
  type GateState,
  type Operation,
  type ReleasePayload,
} from "./payload";
import type { WorkerConfig } from "./worker-config";

export type GitHub = Pick<
  GitHubClient,
  "releaseRecords" | "latestState" | "createRecord" | "setState"
>;

export interface ReleaseDeps {
  github: GitHub;
  worker: WorkerState;
  wrangler: Wrangler;
  config: WorkerConfig;
  log: (message: string) => void;
}

export class ReleaseError extends Error {}

function fail(message: string): never {
  throw new ReleaseError(message);
}

// ---------------------------------------------------------------------------------------------
// Context

export interface ReleaseInputs {
  operation: string;
  confirmation: string;
  allowEmpty: boolean;
  eventName: string;
  ref: string;
  siteUrl: string;
}

/**
 * Only main, only from a dispatch of website-release.yml (CI's Website deploy after a push, the
 * buttons, the change detector, by hand) or its daily schedule (the reconcile release without the
 * relay, docs/release.md: always an ordinary release, never recovery, bootstrap or allow-empty), and
 * the confirmation must name the operation and the canonical host. Which commit is built is pinned
 * separately (green-commit.ts).
 */
export function assertReleaseContext(inputs: ReleaseInputs): Operation {
  const operation = inputs.operation;
  if (operation !== "release" && operation !== "bootstrap" && operation !== "recovery") {
    fail(`Unsupported release operation: ${operation}`);
  }
  if (inputs.eventName === "schedule") {
    if (operation !== "release" || inputs.allowEmpty) {
      fail("The daily schedule runs only an ordinary release, without allow-empty.");
    }
  } else if (inputs.eventName !== "workflow_dispatch") {
    fail("A production release runs only from a workflow dispatch or the daily schedule on main.");
  }
  if (inputs.ref !== "refs/heads/main")
    fail("A production release runs only from refs/heads/main.");
  if (inputs.allowEmpty && operation === "bootstrap") {
    fail("allow-empty is not valid for bootstrap.");
  }
  const host = new URL(inputs.siteUrl).host;
  const expected = `${operation}:${host}${inputs.allowEmpty ? ":allow-empty" : ""}`;
  if (inputs.confirmation !== expected) fail(`The confirmation must exactly equal ${expected}`);
  return operation;
}

// ---------------------------------------------------------------------------------------------
// Gate

export type GateResult =
  { bootstrapRequired: true } | { bootstrapRequired: false; state: GateState };

async function latestSuccessful(
  github: GitHub,
  rows: DeploymentRow[],
  repository?: string,
): Promise<DeploymentRow | undefined> {
  for (const row of rows) {
    if ((await github.latestState(row.id, repository)) === "success") return row;
  }
  return undefined;
}

function baselineFromPayload(deploymentId: string, payload: ReleasePayload): GateState["baseline"] {
  return {
    deploymentId,
    identity: payload.identity,
    workerVersionId: payload.workerVersionId,
    liveOrigin: payload.liveOrigin,
    contentRegistry: payload.contentRegistry,
    verificationContract: payload.verificationContract,
  };
}

/**
 * The first release in this repository continues the content registry of the last successful
 * Vercel-era release (slug history and feed GUIDs), read from the old repository's public
 * GitHub Deployments. Without one, an empty registry needs the protected approval variable.
 */
async function bootstrapBaseline(
  deps: ReleaseDeps,
  options: { legacyRepository?: string; bootstrapApproval?: string; siteUrl: string },
): Promise<GateState["baseline"]> {
  if (options.legacyRepository) {
    const rows = await deps.github.releaseRecords(options.legacyRepository);
    const row = await latestSuccessful(deps.github, rows, options.legacyRepository);
    if (row) {
      const payload = LegacyPayloadSchema.parse(
        typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload,
      );
      if (payload.verificationContract.canonicalOrigin !== options.siteUrl) {
        fail("The legacy release record belongs to another canonical origin.");
      }
      deps.log(
        `bootstrap continues the content registry of ${options.legacyRepository} release record ${row.id}`,
      );
      return {
        deploymentId: `legacy:${options.legacyRepository}#${row.id}`,
        identity: null,
        workerVersionId: null,
        liveOrigin: null,
        contentRegistry: payload.contentRegistry,
        verificationContract: null,
      };
    }
  }
  if (options.bootstrapApproval !== options.siteUrl) {
    fail(
      `No legacy release record to continue; an empty-registry bootstrap additionally requires the production variable WEBSITE_BOOTSTRAP_APPROVAL=${options.siteUrl}.`,
    );
  }
  return {
    deploymentId: "empty",
    identity: null,
    workerVersionId: null,
    liveOrigin: null,
    contentRegistry: emptyContentRegistry(),
    verificationContract: null,
  };
}

export async function gate(
  deps: ReleaseDeps,
  options: {
    operation: Operation;
    legacyRepository?: string;
    bootstrapApproval?: string;
    siteUrl: string;
  },
): Promise<GateResult> {
  const rows = await deps.github.releaseRecords();
  const { operation } = options;

  if (operation === "bootstrap") {
    if (rows.length > 0) fail("bootstrap is allowed only while no website-release record exists.");
    return {
      bootstrapRequired: false,
      state: GateStateSchema.parse({
        schemaVersion: 2,
        operation,
        blocking: null,
        baseline: await bootstrapBaseline(deps, options),
      }),
    };
  }

  const latest = rows[0];
  if (!latest) {
    if (operation === "release") return { bootstrapRequired: true };
    fail("recovery needs an existing website-release record.");
  }
  const latestState = await deps.github.latestState(latest.id);

  if (operation === "release") {
    if (latestState !== "success") {
      fail(
        `The latest website-release state is ${latestState}; only recovery may cross this gate.`,
      );
    }
    return {
      bootstrapRequired: false,
      state: GateStateSchema.parse({
        schemaVersion: 2,
        operation,
        blocking: null,
        baseline: baselineFromPayload(String(latest.id), parsePayload(latest.payload)),
      }),
    };
  }

  // A successful latest record is accepted too: production may have been rolled back by hand to its
  // predecessor (docs/release.md), which only recovery can reconcile.
  const blocking = parsePayload(latest.payload);
  const earlier = await latestSuccessful(deps.github, rows.slice(1));
  const baseline = earlier
    ? baselineFromPayload(String(earlier.id), parsePayload(earlier.payload))
    : blocking.operation === "bootstrap"
      ? await bootstrapBaseline(deps, options)
      : fail("recovery could not find an earlier successful website-release record.");
  return {
    bootstrapRequired: false,
    state: GateStateSchema.parse({
      schemaVersion: 2,
      operation,
      blocking: { deploymentId: String(latest.id), state: latestState, payload: blocking },
      baseline,
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// Baseline and recovery

/** A normal release starts only from the recorded production state. */
export async function checkBaseline(
  deps: ReleaseDeps,
  state: GateState,
  verifyIdentity: (origin: string, identity: BuildIdentity) => Promise<void>,
): Promise<void> {
  const { baseline } = state;
  if (!baseline.workerVersionId || !baseline.identity) {
    fail("The release baseline has no recorded Worker version.");
  }
  const active = await deps.worker.activeVersion();
  if (active !== baseline.workerVersionId) {
    fail(
      `Production serves version ${active ?? "none"}, not the recorded ${baseline.workerVersionId}; it changed outside this workflow. Run the recovery operation.`,
    );
  }
  if (baseline.liveOrigin) await verifyIdentity(baseline.liveOrigin, baseline.identity);
}

/**
 * Reconciles an interrupted or failed release with what production actually serves: either the
 * blocked version (verified again, then marked success) or the earlier baseline. Anything else is
 * a manual situation.
 */
export async function recover(
  deps: ReleaseDeps,
  state: GateState,
  options: {
    verifyRecorded: (payload: {
      liveOrigin: string | null;
      identity: BuildIdentity;
      verificationContract: ReleasePayload["verificationContract"];
    }) => Promise<void>;
    logUrl: string;
  },
): Promise<GateState> {
  const blocking = state.blocking ?? fail("recovery has no blocked record.");
  const active = await deps.worker.activeVersion();
  if (active && active === blocking.payload.workerVersionId) {
    if (
      blocking.payload.previousWorkerVersionId !== state.baseline.workerVersionId &&
      blocking.payload.operation !== "bootstrap"
    ) {
      fail("The blocked version does not descend from the trusted baseline.");
    }
    await options.verifyRecorded(blocking.payload);
    if (blocking.state !== "success") {
      await deps.github.setState(blocking.deploymentId, "success", {
        description: "Recovered after the live version was verified again",
        environmentUrl: blocking.payload.liveOrigin,
        logUrl: options.logUrl,
      });
    }
    deps.log(`recovery: production serves the latest recorded version ${active}; verified`);
    return GateStateSchema.parse({
      ...state,
      blocking: { ...blocking, state: "success" },
      baseline: baselineFromPayload(blocking.deploymentId, blocking.payload),
    });
  }
  if (active && active === state.baseline.workerVersionId && state.baseline.identity) {
    await options.verifyRecorded({
      liveOrigin: state.baseline.liveOrigin,
      identity: state.baseline.identity,
      verificationContract:
        state.baseline.verificationContract ?? fail("The baseline has no verification contract."),
    });
    deps.log(`recovery: production still serves the baseline version ${active}`);
    return state;
  }
  if (!active && !state.baseline.workerVersionId) {
    deps.log("recovery: the Worker was never deployed; continuing as a first deployment");
    return state;
  }
  return fail(
    `Production serves ${active ?? "no version"}, which is neither the blocked nor the baseline version.`,
  );
}

// ---------------------------------------------------------------------------------------------
// Decide, upload, record, deploy

export function decide(options: {
  operation: Operation;
  forceBuild: boolean;
  expected: BuildIdentity;
  state: GateState;
}): { deployRequired: boolean; reason: string } {
  if (options.operation !== "release") {
    return { deployRequired: true, reason: `${options.operation}-always-rebuilds` };
  }
  if (options.forceBuild) return { deployRequired: true, reason: "explicit-force-build" };
  const baseline = options.state.baseline.identity ?? fail("A release needs a baseline identity.");
  return sameIdentity(baseline, options.expected)
    ? { deployRequired: false, reason: "identity-unchanged" }
    : { deployRequired: true, reason: "identity-changed" };
}

export interface UploadResult {
  versionId: string;
  /** The Worker did not exist: `wrangler deploy` created it and it serves this version already. */
  firstDeploy: boolean;
  /** The recorded version this release replaces (the rollback target), if any. */
  previousVersionId: string | null;
}

export function versionMessage(identity: BuildIdentity): string {
  return `website ${identity.codeSha.slice(0, 12)} content ${identity.contentHash.slice(0, 12)}`;
}

export async function upload(
  deps: ReleaseDeps,
  options: { state: GateState; identity: BuildIdentity },
): Promise<UploadResult> {
  const { state } = options;
  const active = await deps.worker.activeVersion();
  const message = versionMessage(options.identity);
  if (state.baseline.workerVersionId && active !== state.baseline.workerVersionId) {
    fail(`Production changed during the release (serves ${active ?? "none"}); nothing uploaded.`);
  }
  if (active === null) {
    // `wrangler versions upload` needs an existing Worker. The first upload is a deploy; the
    // version was verified locally, and nothing routes to the Worker before its first release.
    if (state.operation === "release")
      fail("The Worker does not exist; run the bootstrap operation.");
    const { versionId } = await deps.wrangler.firstDeploy(message);
    return { versionId, firstDeploy: true, previousVersionId: null };
  }
  const { versionId } = await deps.wrangler.uploadVersion(message);
  return {
    versionId,
    firstDeploy: false,
    previousVersionId: state.baseline.workerVersionId,
  };
}

export function buildPayload(options: {
  operation: Operation;
  identity: BuildIdentity;
  upload: UploadResult;
  config: WorkerConfig;
  liveOrigin: string | null;
  workflowUrl: string;
  registry: ContentRegistry;
  manifest: ContentManifest;
  canonicalOrigin: string;
}): ReleasePayload {
  if (options.manifest.sourceMode === "fixture") fail("Fixture content cannot be released.");
  const payload = ReleasePayloadSchema.parse({
    schemaVersion: 3,
    task: "website-release",
    operation: options.operation,
    identity: options.identity,
    workerName: options.config.name,
    workerVersionId: options.upload.versionId,
    previousWorkerVersionId: options.upload.previousVersionId,
    liveOrigin: options.liveOrigin,
    workflowUrl: options.workflowUrl,
    contentRegistry: options.registry,
    verificationContract: {
      canonicalOrigin: options.canonicalOrigin,
      emptyStateText: EMPTY_STATE_TEXT,
      sourceMode: options.manifest.sourceMode,
      routes: options.manifest.routes,
    },
  });
  if (JSON.stringify(options.manifest.candidateRegistry) !== JSON.stringify(options.registry)) {
    fail("The candidate registry does not match the completed manifest.");
  }
  return parsePayload(payload);
}

export async function record(
  deps: ReleaseDeps,
  payload: ReleasePayload,
  options: { ref: string; logUrl: string },
): Promise<number> {
  const id = await deps.github.createRecord(payload, options.ref);
  await deps.github.setState(id, "in_progress", {
    description: "Version uploaded and verified locally; deployment in progress",
    environmentUrl: payload.liveOrigin,
    logUrl: options.logUrl,
  });
  return id;
}

/**
 * Makes the uploaded version serve 100 % of traffic, then applies wrangler.toml's routes (Custom
 * Domains and zone routes).
 * Refuses a production that changed meanwhile. Newer website code on main is not a reason to stop:
 * this build is CI-green and newer than the baseline, and the release that newer push dispatched is
 * queued behind this one in the same concurrency group (stopping here would record a failure that
 * blocks the gate for that release too).
 */
export async function deploy(
  deps: ReleaseDeps,
  options: { upload: UploadResult; identity: BuildIdentity },
): Promise<void> {
  const { upload: uploaded } = options;
  if (!uploaded.firstDeploy) {
    const active = await deps.worker.activeVersion();
    if (uploaded.previousVersionId && active !== uploaded.previousVersionId) {
      fail(`Production changed during the release (serves ${active ?? "none"}).`);
    }
    await deps.wrangler.deployVersion(uploaded.versionId, versionMessage(options.identity));
  }
  const serving = await deps.worker.activeVersion();
  if (serving !== uploaded.versionId) {
    fail(`After the deploy, production serves ${serving ?? "none"}, not ${uploaded.versionId}.`);
  }
  // Custom Domains (and zone routes, if any) from wrangler.toml. wrangler replaces the Worker's Custom
  // Domains with the listed set, so a list equal to the live state changes nothing. With none listed
  // there is nothing to apply (wrangler sends no change then), and workers.dev stays off since the
  // first deploy.
  if (deps.config.hostnames.length > 0) await deps.wrangler.deployTriggers();
}

/**
 * Restores the recorded previous version, only if production serves this release's version, then
 * verifies it where the baseline was last verified (`baseline.liveOrigin`), never at a hostname this
 * failed release was adding: when `wrangler triggers deploy` failed, that hostname (www on its first
 * attach, run 36703886018) still serves whatever answered before, and checking it would turn a clean
 * rollback into an unverified one (`error`).
 */
export async function rollback(
  deps: ReleaseDeps,
  options: {
    upload: UploadResult;
    message: string;
    baseline: GateState["baseline"];
    verifyIdentity: (origin: string, identity: BuildIdentity) => Promise<void>;
  },
): Promise<string> {
  const restore =
    options.upload.previousVersionId ?? fail("There is no recorded version to restore.");
  const active = await deps.worker.activeVersion();
  if (active === restore) {
    deps.log("rollback: production already serves the recorded previous version");
  } else {
    if (active !== options.upload.versionId) {
      fail(`Production serves ${active ?? "none"}; refusing to overwrite a concurrent change.`);
    }
    await deps.wrangler.deployVersion(restore, options.message);
    const settled = await deps.worker.activeVersion();
    if (settled !== restore) {
      fail(`Rollback did not settle: production serves ${settled ?? "none"}.`);
    }
  }
  const { liveOrigin, identity } = options.baseline;
  if (liveOrigin && identity) await options.verifyIdentity(liveOrigin, identity);
  return restore;
}

export async function markRecord(
  deps: ReleaseDeps,
  deploymentId: string,
  state: DeploymentState,
  options: { description: string; environmentUrl: string | null; logUrl: string },
): Promise<void> {
  await deps.github.setState(deploymentId, state, options);
}
