/**
 * `pnpm release <command>`: the steps of .github/workflows/website-release.yml (docs/release.md).
 * Each command reads and writes .generated/release/*.json and GitHub step outputs, so a workflow
 * step shows exactly one stage. No command prints a secret, a response body or Notion content.
 */
import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { siteConfig } from "../../content/site.config";
import { PublicationIdentitySchema } from "../../src/lib/content/publication-state";
import { readContentBundle } from "../../src/lib/content/reader";
import { ContentRegistrySchema } from "../../src/lib/content/schema";
import { CloudflareApi, WranglerCli } from "./cloudflare";
import { GitHubClient } from "./github";
import {
  GateStateSchema,
  ReleasePayloadSchema,
  type BuildIdentity,
  type GateState,
  type Operation,
} from "./payload";
import {
  assertReleaseContext,
  buildPayload,
  checkBaseline,
  decide,
  deploy,
  gate,
  markRecord,
  record,
  recover,
  ReleaseError,
  rollback,
  upload,
  type ReleaseDeps,
  type UploadResult,
} from "./steps";
import { run, runDeploymentTests, startLocalServer, waitForIdentity } from "./verify";
import { liveOrigin, readWorkerConfig } from "./worker-config";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const stateDirectory = path.join(root, ".generated", "release");
const files = {
  gate: path.join(stateDirectory, "gate-state.json"),
  baseline: path.join(stateDirectory, "baseline-registry.json"),
  buildInfo: path.join(stateDirectory, "build-info.json"),
  upload: path.join(stateDirectory, "upload.json"),
  payload: path.join(stateDirectory, "payload.json"),
  contract: path.join(stateDirectory, "verification-contract.json"),
  previousBuildInfo: path.join(stateDirectory, "previous-build-info.json"),
};
/** The monorepo directory whose newest commit is the website's code identity. */
const WEBSITE_DIRECTORY = "website";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new ReleaseError(`Required environment variable is unset: ${name}`);
  return value;
}

function flag(name: string): boolean {
  const value = process.env[name] ?? "false";
  if (value !== "true" && value !== "false")
    throw new ReleaseError(`${name} must be true or false.`);
  return value === "true";
}

async function output(name: string, value: string): Promise<void> {
  if (/[\r\n]/.test(value)) throw new ReleaseError(`Output ${name} must be one line.`);
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}

async function summary(markdown: string): Promise<void> {
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
}

async function readJson<T>(filename: string): Promise<T> {
  return JSON.parse(await readFile(filename, "utf8")) as T;
}

async function writeJson(filename: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`);
}

function siteUrl(): string {
  const value = env("SITE_URL");
  if (value !== siteConfig.canonicalOrigin) {
    throw new ReleaseError(
      "SITE_URL does not exactly match content/site.config.ts canonicalOrigin.",
    );
  }
  return value;
}

function workflowUrl(): string {
  return `${process.env.GITHUB_SERVER_URL ?? "https://github.com"}/${env("GITHUB_REPOSITORY")}/actions/runs/${env("GITHUB_RUN_ID")}`;
}

function operation(): Operation {
  return assertReleaseContext({
    operation: env("RELEASE_OPERATION"),
    confirmation: env("RELEASE_CONFIRMATION"),
    allowEmpty: flag("ALLOW_EMPTY"),
    eventName: env("GITHUB_EVENT_NAME"),
    ref: env("GITHUB_REF"),
    siteUrl: siteUrl(),
  });
}

async function deps(): Promise<ReleaseDeps> {
  const config = await readWorkerConfig(path.join(root, "wrangler.toml"));
  const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
  return {
    config,
    github: new GitHubClient({
      apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
      token: env("GITHUB_TOKEN"),
      repository: env("GITHUB_REPOSITORY"),
    }),
    worker: new CloudflareApi({ config, token: cloudflareToken }),
    wrangler: new WranglerCli({ cwd: root, env: process.env }),
    log: (message) => console.error(`release: ${message}`),
  };
}

async function gateState(): Promise<GateState> {
  return GateStateSchema.parse(await readJson(files.gate));
}

async function expectedIdentity(): Promise<BuildIdentity> {
  return PublicationIdentitySchema.parse(await readJson(files.buildInfo));
}

/** Identity read of a live hostname: waits for a new Custom Domain, then 3 matches in a row. */
function verifyLiveIdentity(origin: string, identity: BuildIdentity): Promise<void> {
  return waitForIdentity(origin, identity, {
    reachAttempts: 20,
    reachDelayMs: 15_000,
    attempts: 12,
    consecutive: 3,
    delayMs: 5_000,
  });
}

async function verifyRecorded(payload: {
  liveOrigin: string | null;
  identity: BuildIdentity;
  verificationContract: unknown;
}): Promise<void> {
  if (!payload.liveOrigin) return;
  await verifyLiveIdentity(payload.liveOrigin, payload.identity);
  await writeJson(files.previousBuildInfo, payload.identity);
  await writeJson(files.contract, payload.verificationContract);
  await runDeploymentTests({
    cwd: root,
    env: process.env,
    baseUrl: payload.liveOrigin,
    expectedBuildInfoPath: files.previousBuildInfo,
    contractPath: files.contract,
  });
}

const commands: Record<string, () => Promise<void>> = {
  async context() {
    await output("operation", operation());
  },

  /** The newest commit that touched website/: the code part of the release identity. */
  async "code-sha"() {
    const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%H", "--", "."], {
      cwd: root,
    });
    const sha = stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha))
      throw new ReleaseError("Could not resolve the website commit.");
    await output("code_sha", sha);
  },

  async "live-origin"() {
    const config = await readWorkerConfig(path.join(root, "wrangler.toml"));
    await output("live_origin", liveOrigin(config, siteUrl()) ?? "");
  },

  async gate() {
    const op = operation();
    const d = await deps();
    const result = await gate(d, {
      operation: op,
      legacyRepository: process.env.WEBSITE_LEGACY_REPOSITORY || undefined,
      bootstrapApproval: process.env.WEBSITE_BOOTSTRAP_APPROVAL || undefined,
      siteUrl: siteUrl(),
    });
    await output("live_origin", liveOrigin(d.config, siteUrl()) ?? "");
    if (result.bootstrapRequired) {
      await output("bootstrap_required", "true");
      console.log(
        "::warning::No website-release record exists in this repository yet. Dispatch website-release.yml once with operation=bootstrap (docs/cutover.md step 1); nothing was released.",
      );
      await summary(
        "### Website release skipped\n\nNo release record exists yet: dispatch **Website release** with `operation: bootstrap` once.",
      );
      return;
    }
    await writeJson(files.gate, result.state);
    await writeJson(files.baseline, result.state.baseline.contentRegistry);
    await output("bootstrap_required", "false");
    await output("baseline_version_id", result.state.baseline.workerVersionId ?? "");
  },

  async recover() {
    const d = await deps();
    const state = await recover(d, await gateState(), { verifyRecorded, logUrl: workflowUrl() });
    await writeJson(files.gate, state);
    await writeJson(files.baseline, state.baseline.contentRegistry);
    await output("baseline_version_id", state.baseline.workerVersionId ?? "");
  },

  async "check-baseline"() {
    const d = await deps();
    await checkBaseline(d, await gateState(), (origin, identity) =>
      waitForIdentity(origin, identity, { attempts: 1 }),
    );
  },

  /** The Notion snapshot for this release (the only step with Notion credentials besides feedback). */
  async prepare() {
    siteUrl();
    if (siteConfig.blogSource !== "notion") {
      throw new ReleaseError(`Unsupported production blogSource: ${siteConfig.blogSource}`);
    }
    env("NOTION_TOKEN");
    env("NOTION_DATA_SOURCE_ID");
    if (env("NOTION_API_VERSION") !== siteConfig.notion.apiVersion) {
      throw new ReleaseError(
        "NOTION_API_VERSION does not match the version pinned in site.config.ts.",
      );
    }
    ContentRegistrySchema.parse(await readJson(files.baseline));
    const args = [
      "--import",
      "tsx",
      "scripts/content/prepare.ts",
      "--source=notion",
      `--baseline=${files.baseline}`,
      "--for-release",
    ];
    if (flag("ALLOW_EMPTY")) args.push("--allow-empty");
    if ((await run("node", args, { cwd: root, env: process.env })) !== 0) {
      throw new ReleaseError("The Notion snapshot could not be prepared.");
    }
  },

  async decide() {
    const op = operation();
    const codeSha = env("CODE_SHA");
    const { manifest } = await readContentBundle(path.join(root, ".generated", "content"));
    if (manifest.sourceMode !== siteConfig.blogSource) {
      throw new ReleaseError(`A release must build ${siteConfig.blogSource} content.`);
    }
    const identity = PublicationIdentitySchema.parse({
      codeSha,
      contentHash: manifest.contentHash,
      configHash: manifest.configHash,
      schemaVersion: manifest.schemaVersion,
    });
    await writeJson(files.buildInfo, identity);
    const result = decide({
      operation: op,
      forceBuild: flag("FORCE_BUILD"),
      expected: identity,
      state: await gateState(),
    });
    await output("deploy_required", String(result.deployRequired));
    await output("reason", result.reason);
  },

  /** The built out/ under `wrangler dev` with wrangler.toml: identity plus the route contract. */
  async "verify-artifact"() {
    const identity = await expectedIdentity();
    const server = await startLocalServer({ cwd: root, env: process.env });
    try {
      await waitForIdentity(server.origin, identity, { attempts: 1 });
      await runDeploymentTests({
        cwd: root,
        env: process.env,
        baseUrl: server.origin,
        expectedBuildInfoPath: files.buildInfo,
      });
    } finally {
      await server.stop();
    }
  },

  async upload() {
    const d = await deps();
    const result = await upload(d, {
      state: await gateState(),
      identity: await expectedIdentity(),
    });
    await writeJson(files.upload, result);
    await output("version_id", result.versionId);
    await output("first_deploy", String(result.firstDeploy));
    await output("previous_version_id", result.previousVersionId ?? "");
  },

  async record() {
    const d = await deps();
    const state = await gateState();
    const identity = await expectedIdentity();
    const uploaded = await readJson<UploadResult>(files.upload);
    const { manifest } = await readContentBundle(path.join(root, ".generated", "content"));
    const payload = buildPayload({
      operation: state.operation,
      identity,
      upload: uploaded,
      config: d.config,
      liveOrigin: liveOrigin(d.config, siteUrl()),
      workflowUrl: workflowUrl(),
      registry: ContentRegistrySchema.parse(
        await readJson(path.join(root, ".generated", "content", "registry.json")),
      ),
      manifest,
      canonicalOrigin: siteUrl(),
    });
    await writeJson(files.payload, payload);
    // The record's ref is the monorepo commit this run checked out (main inside the release lock).
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root });
    const id = await record(d, payload, { ref: stdout.trim(), logUrl: workflowUrl() });
    await output("deployment_id", String(id));
  },

  async deploy() {
    const d = await deps();
    await deploy(d, {
      upload: await readJson<UploadResult>(files.upload),
      identity: await expectedIdentity(),
      websiteDirectory: WEBSITE_DIRECTORY,
    });
  },

  async "verify-live"() {
    const payload = ReleasePayloadSchema.parse(await readJson(files.payload));
    if (!payload.liveOrigin) {
      console.log(
        "::notice::The Worker has no hostname yet (wrangler.toml routes); the version was verified locally only.",
      );
      await output("live_verified", "skipped");
      return;
    }
    await verifyLiveIdentity(payload.liveOrigin, payload.identity);
    await writeJson(files.contract, payload.verificationContract);
    await runDeploymentTests({
      cwd: root,
      env: process.env,
      baseUrl: payload.liveOrigin,
      expectedBuildInfoPath: files.buildInfo,
      contractPath: files.contract,
    });
    await output("live_verified", "true");
  },

  async "mark-success"() {
    const d = await deps();
    const payload = ReleasePayloadSchema.parse(await readJson(files.payload));
    await markRecord(d, env("DEPLOYMENT_ID"), "success", {
      description: payload.liveOrigin
        ? "Deployed and verified on the live hostname"
        : "Deployed; verified locally (no hostname attached yet)",
      environmentUrl: payload.liveOrigin,
      logUrl: workflowUrl(),
    });
  },

  async rollback() {
    const d = await deps();
    const state = await gateState();
    const uploaded = await readJson<UploadResult>(files.upload);
    const restored = await rollback(d, {
      upload: uploaded,
      message: `rollback to ${state.baseline.deploymentId}`,
    });
    const origin = liveOrigin(d.config, siteUrl());
    if (origin && state.baseline.identity)
      await verifyLiveIdentity(origin, state.baseline.identity);
    await output("restored_version_id", restored);
  },

  async "mark-failure"() {
    const d = await deps();
    const restored = flag("ROLLED_BACK");
    await markRecord(d, env("DEPLOYMENT_ID"), restored ? "failure" : "error", {
      description: restored
        ? "Verification failed; the previous version was restored and verified"
        : "Release failed; restoring the previous version was unavailable or unverified",
      environmentUrl: null,
      logUrl: workflowUrl(),
    });
  },
};

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [name] = argv;
  const command = name ? commands[name] : undefined;
  if (!command || argv.length !== 1) {
    throw new ReleaseError(`Usage: pnpm release <${Object.keys(commands).join("|")}>`);
  }
  await command();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    // Messages are ours; library errors are summarized so no response body or secret is printed.
    const message =
      error instanceof ReleaseError || error instanceof Error
        ? error.message
        : "Release step failed.";
    console.error(`release error: ${message}`);
    process.exitCode = 1;
  });
}
