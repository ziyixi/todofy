import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const result = spawnSync(
  process.execPath,
  [
    require.resolve("wrangler/bin/wrangler.js"),
    "deploy",
    "--dry-run",
    "--config",
    "relay/wrangler.toml",
    "--outdir",
    resolve("relay_bundle"),
  ],
  { stdio: "inherit", env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" } },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
