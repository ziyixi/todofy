import { cp, mkdir, readFile, rename, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { validatePreparedContent } from "../content/validate.ts";
import { finalizeExport } from "../export/finalize.ts";
import { readContentBundle } from "../../src/lib/content/reader.ts";

const snapshot = resolve(process.env.JS_BINARY__EXECROOT ?? process.cwd(), process.argv[2] ?? "");
await stat(resolve(snapshot, ".generated/content/snapshot.json")).catch(() => {
  throw new Error(
    "A complete prepared website snapshot is required; provide the website_content repository.",
  );
});
await cp(resolve(snapshot, ".generated"), ".generated", { recursive: true });
for (const folder of ["media", "_img"]) {
  await mkdir(resolve("public", folder), { recursive: true });
  await cp(resolve(snapshot, "public", folder), resolve("public", folder), {
    recursive: true,
  }).catch((error: NodeJS.ErrnoException) => {
    // Bazel's file set does not contain empty directories; content validation checks every referenced file.
    if (error.code !== "ENOENT") throw error;
  });
}
const { snapshot: content } = await readContentBundle(resolve(".generated/content"));
await validatePreparedContent(undefined, undefined, { expectedSource: content.sourceMode });
const require = createRequire(import.meta.url);
const identity = JSON.parse(await readFile("site_identity.json", "utf8")) as { code_sha: string };
const result = spawnSync(
  process.execPath,
  [require.resolve("next/dist/bin/next"), "build", "--webpack"],
  {
    stdio: "inherit",
    env: { ...process.env, CODE_SHA: identity.code_sha, NEXT_TELEMETRY_DISABLED: "1" },
  },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
await finalizeExport();
await rename("out", "site");
