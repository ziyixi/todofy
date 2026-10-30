import { spawnSync } from "node:child_process";
import { cp, rm } from "node:fs/promises";
import path from "node:path";

import { stagePreparedSnapshot } from "./snapshot.ts";

const root = process.cwd();
const workspace = path.resolve(root, "..");
const prepared = path.join(root, ".generated/bazel-inputs");
const bazel = process.env.BAZEL ?? "bazel";
await stagePreparedSnapshot(root, prepared);
const built = spawnSync(
  bazel,
  ["build", "//website:site", `--override_repository=website_content=${prepared}`],
  { cwd: workspace, stdio: "inherit" },
);
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);
const info = spawnSync(bazel, ["info", "bazel-bin"], { cwd: workspace, encoding: "utf8" });
if (info.error) throw info.error;
if (info.status !== 0) throw new Error(info.stderr);
const out = path.join(root, "out");
await rm(out, { recursive: true, force: true });
await cp(path.join(info.stdout.trim(), "website/site"), out, { recursive: true });
