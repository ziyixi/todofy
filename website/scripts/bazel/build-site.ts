import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

import { finalizeExport } from "../export/finalize.ts";

const require = createRequire(import.meta.url);
const next = require.resolve("next/dist/bin/next");
// The framework's webpack backend supports Bazel's declared filesystem layout.
const result = spawnSync(process.execPath, [next, "build", "--webpack"], {
  stdio: "inherit",
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await finalizeExport();
