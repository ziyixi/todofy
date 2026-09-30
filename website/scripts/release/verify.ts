import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import { PublicationIdentitySchema } from "../../src/lib/content/publication-state";
import { sameIdentity, type BuildIdentity } from "./payload";

export type Fetch = typeof fetch;

export interface IdentityWaitOptions {
  fetchImpl?: Fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  log?: (message: string) => void;
  /** Tries while the host cannot be reached yet (a new Custom Domain's DNS and certificate, a new route). */
  reachAttempts?: number;
  reachDelayMs?: number;
  /** Identity reads once reachable; `consecutive` matching reads in a row are required. */
  attempts?: number;
  consecutive?: number;
  delayMs?: number;
}

export const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

type Read = { kind: "unreachable"; detail: string } | { kind: "answer"; identity: BuildIdentity };

async function readIdentity(origin: string, fetchImpl: Fetch): Promise<Read> {
  let response: Response;
  try {
    response = await fetchImpl(`${origin}/build-info.json`, {
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { kind: "unreachable", detail: "no connection" };
  }
  if (response.status >= 500) {
    // 5xx (e.g. 522/526 while a new Custom Domain's DNS and certificate settle) is retried;
    // anything else is an answer that must be correct.
    return { kind: "unreachable", detail: `HTTP ${response.status}` };
  }
  if (response.status !== 200) throw new Error(`build-info.json answered HTTP ${response.status}.`);
  const cacheControl = response.headers.get("cache-control") ?? "";
  if (!/(^|,)\s*no-store\s*(,|$)/i.test(cacheControl)) {
    throw new Error("build-info.json did not carry an explicit no-store cache policy.");
  }
  const body = (await response.json()) as unknown;
  return { kind: "answer", identity: PublicationIdentitySchema.parse(body) };
}

/**
 * Waits until `origin` serves `expected` in `consecutive` reads in a row. Logs commit identifiers
 * only, never response bodies.
 */
export async function waitForIdentity(
  origin: string,
  expected: BuildIdentity,
  options: IdentityWaitOptions = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const log = options.log ?? ((message: string) => console.error(message));
  const reachAttempts = options.reachAttempts ?? 1;
  const attempts = options.attempts ?? 1;
  const consecutive = options.consecutive ?? 1;

  let read: Read | undefined;
  for (let attempt = 1; attempt <= reachAttempts; attempt += 1) {
    read = await readIdentity(origin, fetchImpl);
    if (read.kind === "answer") break;
    log(`${origin} not reachable yet (${read.detail}), attempt ${attempt}/${reachAttempts}`);
    if (attempt < reachAttempts) await sleep(options.reachDelayMs ?? 15_000);
  }
  if (!read || read.kind !== "answer") throw new Error(`${origin} never became reachable.`);

  let matches = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      await sleep(options.delayMs ?? 5_000);
      read = await readIdentity(origin, fetchImpl);
    }
    if (read.kind === "answer" && sameIdentity(read.identity, expected)) {
      matches += 1;
      if (matches >= consecutive) return;
      continue;
    }
    matches = 0;
    const actual = read.kind === "answer" ? read.identity.codeSha : read.detail;
    log(
      `identity mismatch on attempt ${attempt}/${attempts}: expected codeSha=${expected.codeSha}, got ${actual}`,
    );
  }
  throw new Error(
    matches === 0
      ? `${origin} does not serve the expected build identity.`
      : `${origin} did not serve the expected identity ${consecutive} times in a row.`,
  );
}

/** Runs a command, inheriting output; resolves with its exit code. */
export function run(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}

/**
 * The route contract (tests/e2e/deployment.spec.ts): every recorded route, asset hash, redirect,
 * 404, the segment payloads and a browser pass without console errors.
 */
export async function runDeploymentTests(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  baseUrl: string;
  expectedBuildInfoPath: string;
  contractPath?: string;
}): Promise<void> {
  const env: NodeJS.ProcessEnv = {
    ...options.env,
    DEPLOYMENT_BASE_URL: options.baseUrl,
    EXPECTED_BUILD_INFO_PATH: options.expectedBuildInfoPath,
  };
  delete env.DEPLOYMENT_CONTRACT_PATH;
  if (options.contractPath) env.DEPLOYMENT_CONTRACT_PATH = options.contractPath;
  // Credentials are never needed by the route checks.
  delete env.CLOUDFLARE_API_TOKEN;
  delete env.GITHUB_TOKEN;
  const code = await run("pnpm", ["test:deployment"], { cwd: options.cwd, env });
  if (code !== 0) throw new Error(`Deployment route tests failed against ${options.baseUrl}.`);
}

/**
 * `wrangler dev` serving out/ with wrangler.toml (what `pnpm start` runs) until `stop()` is called.
 * The binary is started directly so stopping it does not make a package-manager wrapper log a failure.
 */
export async function startLocalServer(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  origin?: string;
  fetchImpl?: Fetch;
}): Promise<{ origin: string; stop: () => Promise<void> }> {
  const origin = options.origin ?? "http://127.0.0.1:4173";
  const env: NodeJS.ProcessEnv = { ...options.env, WRANGLER_SEND_METRICS: "false" };
  delete env.CLOUDFLARE_API_TOKEN;
  const { hostname, port } = new URL(origin);
  const wrangler = path.join(options.cwd, "node_modules", ".bin", "wrangler");
  const args = ["dev", "--config", "wrangler.toml", "--ip", hostname, "--port", port];
  const child: ChildProcess = spawn(wrangler, args, {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "inherit", "inherit"],
    detached: true,
  });
  const stop = async () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    await new Promise((resolve) => child.once("close", resolve));
  };
  const fetchImpl = options.fetchImpl ?? fetch;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error("The local asset server exited early.");
    try {
      const response = await fetchImpl(`${origin}/build-info.json`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return { origin, stop };
    } catch {
      // Not listening yet.
    }
    await defaultSleep(1_000);
  }
  await stop();
  throw new Error("The local asset server did not become ready.");
}
