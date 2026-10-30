import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "vitest";

import { prepareContent } from "../../scripts/content/prepare";
import { stagePreparedSnapshot } from "../../scripts/bazel/snapshot";
import { hashContentSnapshot } from "../../src/lib/content/hash";

test("Bazel receives the complete validated public snapshot, without private capture inputs", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "website-bazel-snapshot-"));
  const source = path.join(temporary, "source");
  const destination = path.join(temporary, "repository");
  try {
    await mkdir(source);
    await prepareContent({
      source: "empty",
      outputDirectory: path.join(source, ".generated/content"),
      publicDirectory: path.join(source, "public"),
    });
    // Synthetic Notion-shaped content exercises the production staging boundary without calling Notion.
    const snapshotFile = path.join(source, ".generated/content/snapshot.json");
    const manifestFile = path.join(source, ".generated/content/manifest.json");
    const snapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
    snapshot.sourceMode = "notion";
    const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
    manifest.sourceMode = "notion";
    manifest.contentHash = hashContentSnapshot(snapshot);
    await writeFile(snapshotFile, JSON.stringify(snapshot));
    await writeFile(manifestFile, JSON.stringify(manifest));
    await writeFile(path.join(source, ".generated/images.json"), "{}");
    await mkdir(path.join(source, "public/_img"), { recursive: true });
    await writeFile(
      path.join(source, ".generated/private-capture.json"),
      "synthetic private input",
    );
    await writeFile(path.join(source, ".env"), "SYNTHETIC_ONLY=excluded");
    await stagePreparedSnapshot(source, destination);
    expect(await readFile(path.join(destination, ".generated/content/snapshot.json"), "utf8")).toBe(
      await readFile(snapshotFile, "utf8"),
    );
    await expect(
      readFile(path.join(destination, ".generated/private-capture.json")),
    ).rejects.toThrow();
    await expect(readFile(path.join(destination, ".env"))).rejects.toThrow();
    await expect(readFile(path.join(destination, "BUILD.bazel"), "utf8")).resolves.toContain(
      "filegroup",
    );
    await expect(readFile(path.join(destination, "REPO.bazel"), "utf8")).resolves.toBe("");
    await writeFile(snapshotFile, "{}");
    await expect(stagePreparedSnapshot(source, path.join(temporary, "invalid"))).rejects.toThrow();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
