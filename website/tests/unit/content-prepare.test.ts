import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { siteConfig } from "../../content/site.config";
import { prepareContent } from "../../scripts/content/prepare";
import { validatePreparedContent } from "../../scripts/content/validate";
import { readContentBundle } from "../../src/lib/content/reader";
import { emptyContentRegistry } from "../../src/lib/content/registry";
import { ContentRegistrySchema } from "../../src/lib/content/schema";

const temporaryDirectories: string[] = [];

async function temporaryWorkspace() {
  const root = await mkdtemp(path.join(tmpdir(), "ziyixi-content-test-"));
  temporaryDirectories.push(root);
  return {
    outputDirectory: path.join(root, "content"),
    publicDirectory: path.join(root, "public"),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("prepared content bundle", () => {
  it("prepares and validates a legal empty snapshot without Notion", async () => {
    const paths = await temporaryWorkspace();
    const manifest = await prepareContent({
      source: "empty",
      baseline: emptyContentRegistry(),
      ...paths,
      completedAt: new Date("2026-01-01T00:00:00Z"),
    });
    expect(manifest.postCount).toBe(0);
    await expect(readContentBundle(paths.outputDirectory)).resolves.toMatchObject({
      snapshot: { sourceMode: "empty", posts: [] },
      manifest: { complete: true },
    });
    await expect(
      validatePreparedContent(paths.outputDirectory, paths.publicDirectory, {
        expectedSource: "empty",
      }),
    ).resolves.toMatchObject({ posts: 0, sourceMode: "empty" });
  });

  it("prepares a representative synthetic fixture", async () => {
    const paths = await temporaryWorkspace();
    const manifest = await prepareContent({
      source: "fixture",
      baseline: emptyContentRegistry(),
      ...paths,
    });
    expect(manifest.postCount).toBe(2);
    await expect(
      validatePreparedContent(paths.outputDirectory, paths.publicDirectory, {
        expectedSource: "fixture",
      }),
    ).resolves.toMatchObject({ posts: 2, sourceMode: "fixture" });
    const { snapshot } = await readContentBundle(paths.outputDirectory);
    expect(snapshot.posts[0]?.slug).toBe("reliable-content-pipelines");
    expect(snapshot.posts[0]?.blocks.some((block) => block.type === "table")).toBe(true);
    expect(snapshot.posts[0]?.blocks.find((block) => block.type === "bookmark")).toMatchObject({
      type: "bookmark",
      href: "https://developers.notion.com/",
      caption: [
        {
          text: "Notion developer documentation",
          href: "https://example.com/caption",
        },
      ],
    });
  });

  it("rejects an empty snapshot when Notion is expected", async () => {
    const paths = await temporaryWorkspace();
    await prepareContent({
      source: "empty",
      baseline: emptyContentRegistry(),
      ...paths,
    });

    await expect(
      validatePreparedContent(paths.outputDirectory, paths.publicDirectory, {
        expectedSource: "notion",
      }),
    ).rejects.toMatchObject({ code: "CONTENT_MODE_MISMATCH" });
    if (siteConfig.blogSource === "notion") {
      await expect(
        validatePreparedContent(paths.outputDirectory, paths.publicDirectory),
      ).rejects.toMatchObject({ code: "CONTENT_MODE_MISMATCH" });
    }
  });

  it("requires an explicit fixture source and rejects the wrong offline source", async () => {
    const paths = await temporaryWorkspace();
    await prepareContent({
      source: "fixture",
      baseline: emptyContentRegistry(),
      ...paths,
    });

    await expect(
      validatePreparedContent(paths.outputDirectory, paths.publicDirectory),
    ).rejects.toMatchObject({ code: "CONTENT_MODE_MISMATCH" });
    await expect(
      validatePreparedContent(paths.outputDirectory, paths.publicDirectory, {
        expectedSource: "empty",
      }),
    ).rejects.toMatchObject({ code: "CONTENT_MODE_MISMATCH" });
  });

  it("records withdrawn article paths as expected 404 deployment checks", async () => {
    const paths = await temporaryWorkspace();
    await prepareContent({
      source: "fixture",
      baseline: emptyContentRegistry(),
      ...paths,
    });
    const baseline = ContentRegistrySchema.parse(
      JSON.parse(
        await readFile(path.join(paths.outputDirectory, "registry.json"), "utf8"),
      ) as unknown,
    );
    const manifest = await prepareContent({
      source: "empty",
      baseline,
      allowEmpty: true,
      ...paths,
    });

    expect(manifest.routes).toContainEqual({
      expectedStatus: 404,
      kind: "absent",
      path: "/blog/reliable-content-pipelines",
    });
  });

  it("detects snapshot tampering through the manifest hash", async () => {
    const paths = await temporaryWorkspace();
    await prepareContent({
      source: "empty",
      baseline: emptyContentRegistry(),
      ...paths,
    });
    const snapshotPath = path.join(paths.outputDirectory, "snapshot.json");
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<string, unknown>;
    snapshot.sourceMode = "fixture";
    await writeFile(snapshotPath, JSON.stringify(snapshot), "utf8");
    await expect(readContentBundle(paths.outputDirectory)).rejects.toThrow(
      /source modes differ|hash/i,
    );
  });

  it("rejects a registry file that diverges from the manifest candidate registry", async () => {
    const paths = await temporaryWorkspace();
    await prepareContent({
      source: "fixture",
      baseline: emptyContentRegistry(),
      ...paths,
    });
    const registryPath = path.join(paths.outputDirectory, "registry.json");
    const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
      articleCount: number;
    };
    registry.articleCount += 1;
    await writeFile(registryPath, JSON.stringify(registry), "utf8");

    await expect(
      validatePreparedContent(paths.outputDirectory, paths.publicDirectory, {
        expectedSource: "fixture",
      }),
    ).rejects.toMatchObject({ code: "REGISTRY_MANIFEST_MISMATCH" });
  });

  it("rejects fixture at the release boundary", async () => {
    const paths = await temporaryWorkspace();
    await expect(
      prepareContent({
        source: "fixture",
        baseline: emptyContentRegistry(),
        forRelease: true,
        ...paths,
      }),
    ).rejects.toThrow(/cannot be used/);
  });
});
