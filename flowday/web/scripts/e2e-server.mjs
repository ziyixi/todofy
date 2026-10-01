#!/usr/bin/env node
// The app the Playwright suite and the screenshot scripts drive: the E2E static export (E2E_TEST_MODE=1, with the
// test bridge) served by the Worker "flowday" under `wrangler dev`, with a fresh local D1 (../migrations applied),
// the loopback dev bypass and the /api/test/* routes. Local only: nothing here reaches Cloudflare.
//
//   node scripts/e2e-server.mjs [--port 4567] [--skip-build]
//
// The values below are synthetic test values (no real owner, key or token).
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerDir = path.resolve(webDir, "..", "worker");
const stateDir = path.join(webDir, "output", "e2e-state");

const TEST_VARS = {
  DEV_AUTH_BYPASS: "true",
  E2E_TEST_ROUTES: "true",
  ACCESS_OWNER: "owner@example.com",
  CSRF_SIGNING_KEY: "e2e0".repeat(16),
  CREDENTIAL_KEY: "e2e1".repeat(16),
  BUILD_SHA: "dev",
};

function run(command, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
    child.on("error", reject);
    child.on("exit", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args[0] ?? ""} exited with ${code ?? signal}`))
    );
  });
}

const wranglerEnv = { WRANGLER_SEND_METRICS: "false", TZ: "UTC" };

/** Builds the E2E export into out/ and gives the local D1 a fresh, migrated database. */
export async function prepareE2E({ skipBuild = false } = {}) {
  if (!skipBuild) {
    await run("npm", ["run", "build"], webDir, { E2E_TEST_MODE: "1", TZ: "UTC", NEXT_TELEMETRY_DISABLED: "1" });
  }
  await rm(stateDir, { recursive: true, force: true });
  await mkdir(stateDir, { recursive: true });
  await run(
    "npx",
    ["--no-install", "wrangler", "d1", "migrations", "apply", "DB", "--local", "--config", "../wrangler.toml", "--persist-to", stateDir],
    workerDir,
    { ...wranglerEnv, CI: "1" }
  );
}

/** Starts `wrangler dev` on 127.0.0.1:<port>; returns the child process. */
export function startE2EWorker(port) {
  const vars = Object.entries(TEST_VARS).flatMap(([name, value]) => ["--var", `${name}:${value}`]);
  const child = spawn(
    "npx",
    [
      "--no-install", "wrangler", "dev", "--config", "../wrangler.toml", "--ip", "127.0.0.1", "--port", String(port),
      "--local-upstream", `127.0.0.1:${port}`, "--persist-to", stateDir, "--show-interactive-dev-session=false", ...vars,
    ],
    { cwd: workerDir, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ...wranglerEnv } }
  );
  return child;
}

/** Waits until GET /api/test/health answers. */
export async function waitForE2E(baseURL, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseURL}/api/test/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${baseURL}: ${lastError?.message ?? "no response"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf("--port");
  const port = Number(portIndex >= 0 ? args[portIndex + 1] : process.env.PLAYWRIGHT_PORT ?? 4567);
  await prepareE2E({ skipBuild: args.includes("--skip-build") });
  const child = startE2EWorker(port);
  const stop = () => child.kill("SIGTERM");
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  child.on("exit", (code) => process.exit(code ?? 0));
}
