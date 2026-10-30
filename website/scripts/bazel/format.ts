import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const packageFile = require.resolve("prettier/package.json");
const metadata = JSON.parse(readFileSync(packageFile, "utf8")) as { bin: string };
const config = realpathSync("prettier.config.mjs");
// Prettier refuses symlink arguments. Its rules and ignore file still belong to this project.
const result = spawnSync(
  process.env.JS_BINARY__NODE_BINARY ?? process.execPath,
  [
    resolve(dirname(packageFile), metadata.bin),
    "--check",
    "--ignore-unknown",
    "--config",
    config,
    "--ignore-path",
    realpathSync(".prettierignore"),
    ...process.argv.slice(2).map((file) => realpathSync(file)),
  ],
  { cwd: dirname(config), stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
