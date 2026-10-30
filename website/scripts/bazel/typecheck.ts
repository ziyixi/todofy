import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
for (const [entry, args] of [
  ["next/dist/bin/next", ["typegen"]],
  ["typescript/bin/tsc", ["--noEmit"]],
] as const) {
  const result = spawnSync(process.execPath, [require.resolve(entry), ...args], {
    stdio: "inherit",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
