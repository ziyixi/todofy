#!/usr/bin/env node
// Relay deployment: source identity and an optional complete map of its declared secrets.
// deploy-vars-inputs exec: GITHUB_SHA
import { spawnSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mergeWorkerSecrets } from "../../../tools/cloud-config/worker-secrets.mjs";

export const CONFIG = fileURLToPath(new URL("../wrangler.toml", import.meta.url));
export const INJECTED = [{ name: "BUILD_SHA", from: "GITHUB_SHA", kind: "build" }];
export class SettingError extends Error {
  constructor(name) {
    super(`Invalid or missing deploy setting: ${name}`);
    this.setting = name;
  }
}
export function injectedVars(env) {
  const source = env.BUILD_SOURCE_SHA ? "BUILD_SOURCE_SHA" : "GITHUB_SHA";
  const value = env[source];
  if (typeof value !== "string" || value.length !== 40 || !/^[a-f0-9]{40}$/.test(value))
    throw new SettingError(source);
  return { BUILD_SHA: value };
}
export function wranglerArgs(env) {
  return ["--var", `BUILD_SHA:${injectedVars(env).BUILD_SHA}`];
}
export function generateSecrets(env) {
  return mergeWorkerSecrets("ziyixi-notion-publish", env, {}, SettingError);
}
export function writeSecrets(path, env) {
  writeFileSync(path, JSON.stringify(generateSecrets(env), null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
}
export function refusal(argv, cwd = process.cwd()) {
  let config = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env" || arg === "-e" || arg.startsWith("--env=") || /^-e./.test(arg))
      return "--env is not allowed: the top level is production";
    if (arg === "--keep-vars" || arg.startsWith("--keep-vars="))
      return "--keep-vars is not allowed: the config is the source of truth";
    if (arg === "--var" || arg.startsWith("--var=")) return "--var is added by this wrapper only";
    if (arg === "--config" || arg === "-c") config = argv[index + 1] ?? "";
    else if (arg.startsWith("--config=")) config = arg.slice("--config=".length);
  }
  if (!argv.includes("deploy"))
    return "only a deploy (or a --dry-run deploy) runs through this wrapper";
  try {
    if (config && realpathSync(resolve(cwd, config)) === realpathSync(CONFIG)) return null;
  } catch {
    /* Missing config is refused below. */
  }
  return `--config must name ${CONFIG}`;
}
export function run(argv, env = process.env) {
  const [command, ...rest] = argv;
  if (command === "check" && rest.length === 0) {
    injectedVars(env);
    generateSecrets(env);
    console.log("Deploy values are valid (not printed).");
    return 0;
  }
  if (command === "secrets" && rest.length === 1) {
    writeSecrets(rest[0], env);
    console.log("Wrote the relay secrets file (values not printed).");
    return 0;
  }
  if (command === "exec" && rest[0] === "--") {
    const child = rest.slice(1);
    const reason = refusal(child);
    if (reason) {
      console.error(`Refused: ${reason}.`);
      return 2;
    }
    const result = spawnSync(child[0], [...child.slice(1), ...wranglerArgs(env)], {
      stdio: "inherit",
      env,
    });
    return result.error ? 1 : (result.status ?? 1);
  }
  console.error(
    "Usage: deploy-vars.mjs check | secrets <path> | exec -- <wrangler deploy command…>",
  );
  return 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof SettingError
        ? error.message
        : error?.code === "EEXIST"
          ? "The secrets file already exists; nothing was overwritten."
          : "Unable to prepare the relay deploy values.",
    );
    process.exitCode = 1;
  }
}
