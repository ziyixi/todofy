import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { WorkerVersionIdSchema } from "./payload";
import type { WorkerConfig } from "./worker-config";

export type Fetch = typeof fetch;

/** Cloudflare's "script not found" error codes (as wrangler's isWorkerNotFoundError). */
const WORKER_NOT_FOUND = new Set([10007, 10090]);

/** Read-only view of the Worker's production state through the REST API. */
export interface WorkerState {
  /** The version serving 100 % of traffic, or null when the Worker does not exist yet. */
  activeVersion(): Promise<string | null>;
}

export class CloudflareApi implements WorkerState {
  constructor(
    private readonly options: {
      config: WorkerConfig;
      token: string;
      fetchImpl?: Fetch;
      apiUrl?: string;
    },
  ) {}

  async activeVersion(): Promise<string | null> {
    const { config } = this.options;
    const url = `${this.options.apiUrl ?? "https://api.cloudflare.com/client/v4"}/accounts/${config.accountId}/workers/scripts/${config.name}/deployments`;
    const response = await (this.options.fetchImpl ?? fetch)(url, {
      headers: { Authorization: `Bearer ${this.options.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await response.json().catch(() => ({}))) as {
      success?: boolean;
      errors?: { code?: number }[];
      result?: { deployments?: { versions?: { version_id?: string; percentage?: number }[] }[] };
    };
    if (
      response.status === 404 ||
      body.errors?.some((error) => WORKER_NOT_FOUND.has(error.code ?? 0))
    ) {
      return null;
    }
    if (!response.ok || body.success !== true) {
      throw new Error(`Cloudflare deployments read failed with HTTP ${response.status}.`);
    }
    const latest = body.result?.deployments?.[0];
    if (!latest) return null;
    const versions = latest.versions ?? [];
    if (versions.length !== 1 || versions[0]?.percentage !== 100) {
      throw new Error(
        "The Worker's latest deployment splits traffic between versions; the release deploys only whole versions. Use recovery after settling it.",
      );
    }
    return WorkerVersionIdSchema.parse(versions[0].version_id);
  }
}

export interface WranglerResult {
  versionId: string;
}

/** The wrangler commands a release runs; production mutations go through wrangler only. */
export interface Wrangler {
  /** `wrangler deploy`: the Worker's first upload, which also serves it at once. */
  firstDeploy(message: string): Promise<WranglerResult>;
  /** `wrangler versions upload`: a new version that serves nothing yet. */
  uploadVersion(message: string): Promise<WranglerResult>;
  /** `wrangler versions deploy <id>@100%`. */
  deployVersion(versionId: string, message: string): Promise<void>;
  /** `wrangler triggers deploy`: Custom Domains and zone routes from wrangler.toml, workers.dev off. */
  deployTriggers(): Promise<void>;
}

interface OutputEntry {
  type?: string;
  version_id?: string | null;
}

/**
 * Runs `pnpm exec wrangler` from the website directory with the release's Cloudflare credentials,
 * reading results from wrangler's structured output file (WRANGLER_OUTPUT_FILE_PATH), never from
 * its human-readable log.
 */
export class WranglerCli implements Wrangler {
  constructor(
    private readonly options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      configFile?: string;
    },
  ) {}

  private async run(args: string[]): Promise<OutputEntry[]> {
    const directory = await mkdtemp(path.join(tmpdir(), "website-wrangler-"));
    const outputFile = path.join(directory, "output.jsonl");
    try {
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(
          "pnpm",
          ["exec", "wrangler", ...args, "--config", this.options.configFile ?? "wrangler.toml"],
          {
            cwd: this.options.cwd,
            env: {
              ...this.options.env,
              WRANGLER_OUTPUT_FILE_PATH: outputFile,
              WRANGLER_SEND_METRICS: "false",
              CI: "true",
            },
            stdio: ["ignore", "inherit", "inherit"],
          },
        );
        child.on("error", reject);
        child.on("close", (status) => resolve(status ?? 1));
      });
      if (code !== 0) throw new Error(`wrangler ${args[0]} ${args[1] ?? ""} exited with ${code}.`);
      const text = await readFile(outputFile, "utf8").catch(() => "");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as OutputEntry);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private static versionFrom(entries: OutputEntry[], type: string): WranglerResult {
    const entry = entries.find((candidate) => candidate.type === type);
    return { versionId: WorkerVersionIdSchema.parse(entry?.version_id) };
  }

  async firstDeploy(message: string): Promise<WranglerResult> {
    return WranglerCli.versionFrom(await this.run(["deploy", "--message", message]), "deploy");
  }

  async uploadVersion(message: string): Promise<WranglerResult> {
    return WranglerCli.versionFrom(
      await this.run(["versions", "upload", "--message", message]),
      "version-upload",
    );
  }

  async deployVersion(versionId: string, message: string): Promise<void> {
    WorkerVersionIdSchema.parse(versionId);
    await this.run(["versions", "deploy", `${versionId}@100%`, "--message", message, "--yes"]);
  }

  async deployTriggers(): Promise<void> {
    await this.run(["triggers", "deploy"]);
  }
}

/**
 * The monorepo's deploy-time hostname guard (tools/cf-guard): read-only, it fails when applying
 * wrangler.toml's routes would detach a live Custom Domain or zone route of this Worker, or take over
 * another Worker's hostname or an existing DNS record. A release runs it before anything that applies
 * routes (`wrangler deploy` of a first upload, `wrangler triggers deploy`).
 */
export interface HostnameGuard {
  check(): Promise<void>;
}

/**
 * Runs `node ../tools/cf-guard/cf-guard.mjs --config wrangler.toml` from the website directory with only
 * the token and the guard's allow-lists in its environment. It prints hostnames and PASS/FAIL, never a
 * response body or id; a non-zero exit refuses the release.
 */
export class HostnameGuardCli implements HostnameGuard {
  constructor(
    private readonly options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      configFile?: string;
    },
  ) {}

  async check(): Promise<void> {
    const { cwd, env } = this.options;
    const script = path.resolve(cwd, "..", "tools", "cf-guard", "cf-guard.mjs");
    const code = await new Promise<number>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [script, "--config", this.options.configFile ?? "wrangler.toml"],
        {
          cwd,
          env: {
            NODE_ENV: env.NODE_ENV,
            PATH: env.PATH ?? "",
            CLOUDFLARE_API_TOKEN: env.CLOUDFLARE_API_TOKEN ?? "",
            CF_GUARD_ALLOW_REMOVE: env.CF_GUARD_ALLOW_REMOVE ?? "",
            CF_GUARD_ALLOW_CONFLICT: env.CF_GUARD_ALLOW_CONFLICT ?? "",
          },
          stdio: ["ignore", "inherit", "inherit"],
        },
      );
      child.on("error", reject);
      child.on("close", (status) => resolve(status ?? 1));
    });
    if (code !== 0) {
      throw new Error(
        `The hostname guard (tools/cf-guard) refused to change this Worker's hostnames (exit ${code}).`,
      );
    }
  }
}
