import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { prepareContent } from "../content/prepare.ts";
import { finalizeExport } from "../export/finalize.ts";
import { prepareSiteImages } from "../images/prepare.ts";

const require = createRequire(import.meta.url);
const source = process.cwd();
const temporary = await mkdtemp(join(tmpdir(), "website-bazel-fixture-"));
try {
  for (const folder of ["src", "scripts", "content", "public", "tests/fixtures"]) {
    await mkdir(join(temporary, folder, ".."), { recursive: true });
    await cp(join(source, folder), join(temporary, folder), { recursive: true, dereference: true });
  }
  for (const file of ["next.config.ts", "next-env.d.ts", "package.json", "tsconfig.json"]) {
    await cp(join(source, file), join(temporary, file), { dereference: true });
  }
  await symlink(join(source, "node_modules"), join(temporary, "node_modules"), "dir");
  process.chdir(temporary);
  const baseline = JSON.parse(await readFile("tests/fixtures/baseline-empty.json", "utf8"));
  const time = new Date("2026-10-01T00:00:00Z");
  await prepareContent({ source: "fixture", baseline, cutoff: time, completedAt: time });
  await prepareSiteImages({});
  const result = spawnSync(
    process.execPath,
    [require.resolve("next/dist/bin/next"), "build", "--webpack"],
    {
      stdio: "inherit",
      env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Next fixture export failed (${String(result.status)})`);
  await finalizeExport();
  await cp("out", resolve(source, "fixture_site"), { recursive: true });
  await cp(".generated/content/manifest.json", resolve(source, "fixture_manifest.json"));
} finally {
  process.chdir(source);
  await rm(temporary, { recursive: true, force: true });
}
