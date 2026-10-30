import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { sourcePaths, websiteCodeSha } from "../../scripts/bazel/source-identity";

const exec = promisify(execFile);

test("the site identity follows declared sources and build definitions, excluding unrelated commits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "website-source-identity-"));
  const previousPath = process.env.PATH;
  try {
    const labels =
      "//website:src/page.tsx\n//website:BUILD.bazel\n//:package.json\n@npm//:external.js\n";
    expect(sourcePaths(labels)).toContain("website/src/page.tsx");
    expect(sourcePaths(labels)).toContain("website/BUILD.bazel");
    expect(sourcePaths(labels)).toContain("package.json");
    expect(sourcePaths(labels).some((file) => file.includes("external.js"))).toBe(false);
    await mkdir(path.join(root, "bin"));
    // The graph fixture supplies labels; real Git history tests the release's component identity.
    await writeFile(path.join(root, "bin/bazel"), "#!/bin/sh\nprintf '%s' '" + labels + "'\n");
    await chmod(path.join(root, "bin/bazel"), 0o755);
    process.env.PATH = path.join(root, "bin") + path.delimiter + previousPath;
    const git = async (...args: string[]) => (await exec("git", args, { cwd: root })).stdout.trim();
    await git("init", "--quiet");
    await git("config", "user.name", "Synthetic website test");
    await git("config", "user.email", "fixture@example.invalid");
    for (const file of ["website/src/page.tsx", "website/BUILD.bazel", "package.json"]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "synthetic source\n");
      await git("add", file);
      await git("commit", "--quiet", "-m", "Change declared input");
      expect(await websiteCodeSha(root)).toBe(await git("rev-parse", "HEAD"));
    }
    const identity = await websiteCodeSha(root);
    await writeFile(path.join(root, "unrelated.txt"), "unrelated source\n");
    await git("add", "unrelated.txt");
    await git("commit", "--quiet", "-m", "Change unrelated input");
    expect(await websiteCodeSha(root)).toBe(identity);
  } finally {
    process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
