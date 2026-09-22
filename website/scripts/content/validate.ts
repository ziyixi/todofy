import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { asContentError, ContentError } from "../../src/lib/content/errors";
import { hashPublicConfig } from "../../src/lib/content/hash";
import { readContentBundle } from "../../src/lib/content/reader";
import { ContentRegistrySchema } from "../../src/lib/content/schema";
import { readSiteData } from "../../src/lib/content/site-data";
import { stableStringify } from "../../src/lib/content/stable-json";
import { validateContentSnapshotWithOptions } from "../../src/lib/content/validate";
import { assertKnownArguments, parseCliArguments } from "./args";
import { parseExplicitSource } from "./mode";
import type { SourceMode } from "./types";

export async function validatePreparedContent(
  inputDirectory = path.join(process.cwd(), ".generated", "content"),
  publicDirectory = path.join(process.cwd(), "public"),
  options: { expectedSource?: SourceMode } = {},
): Promise<{ posts: number; media: number; sourceMode: string }> {
  const resolvedInputDirectory = path.resolve(inputDirectory);
  const [{ snapshot, manifest }, siteData, registry] = await Promise.all([
    readContentBundle(resolvedInputDirectory),
    readSiteData(),
    readPreparedRegistry(resolvedInputDirectory),
  ]);
  if (manifest.configHash !== hashPublicConfig(siteData.siteConfig)) {
    throw new ContentError(
      "CONFIG_HASH_MISMATCH",
      "Prepared content uses a different public config.",
    );
  }
  const expectedSource = options.expectedSource ?? siteData.siteConfig.blogSource;
  if (snapshot.sourceMode !== expectedSource) {
    throw new ContentError(
      "CONTENT_MODE_MISMATCH",
      `Prepared ${snapshot.sourceMode} content does not match expected ${expectedSource} mode.`,
    );
  }
  if (
    process.env.SITE_URL &&
    new URL(process.env.SITE_URL).origin !== siteData.siteConfig.canonicalOrigin
  ) {
    throw new ContentError("SITE_URL_MISMATCH", "SITE_URL does not match site.config.ts.");
  }
  validateSiteRelationships(siteData);
  validateContentSnapshotWithOptions(snapshot, {
    allowCvPath: Boolean(siteData.profile.cvPath),
    canonicalOrigin: siteData.siteConfig.canonicalOrigin,
  });
  await validateOptionalCv(siteData.profile.cvPath, path.resolve(publicDirectory));
  validateRegistryMatchesSnapshot(snapshot.posts, manifest.candidateRegistry.posts);
  if (stableStringify(registry) !== stableStringify(manifest.candidateRegistry)) {
    throw new ContentError(
      "REGISTRY_MANIFEST_MISMATCH",
      "Prepared registry does not match the candidate registry committed by the manifest.",
    );
  }

  for (const asset of snapshot.media) {
    const relative = asset.path.replace(/^\//, "");
    const diskPath = path.resolve(publicDirectory, relative);
    if (!diskPath.startsWith(`${path.resolve(publicDirectory)}${path.sep}`)) {
      throw new ContentError("UNSAFE_MEDIA_PATH", `Media escapes public directory: ${asset.path}`);
    }
    const bytes = await readFile(diskPath);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== asset.sizeBytes || digest !== asset.sha256) {
      throw new ContentError("MEDIA_HASH_MISMATCH", `Media does not match snapshot: ${asset.path}`);
    }
  }
  await assertNoOrphanedMedia(
    path.resolve(publicDirectory),
    new Set(snapshot.media.map((asset) => asset.path)),
  );
  return {
    posts: snapshot.posts.length,
    media: snapshot.media.length,
    sourceMode: snapshot.sourceMode,
  };
}

async function validateOptionalCv(cvPath: string | undefined, publicDirectory: string) {
  if (!cvPath) return;
  const diskPath = path.resolve(publicDirectory, cvPath.slice(1));
  if (!diskPath.startsWith(`${publicDirectory}${path.sep}`)) {
    throw new ContentError("UNSAFE_CV_PATH", "Configured CV path escapes the public directory.");
  }
  try {
    const bytes = await readFile(diskPath);
    if (bytes.byteLength < 5 || bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new ContentError("INVALID_CV_FILE", "Configured CV file is not a readable PDF.");
    }
  } catch (error) {
    if (error instanceof ContentError) throw error;
    throw new ContentError("MISSING_CV_FILE", `Configured CV file is missing: ${cvPath}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readPreparedRegistry(inputDirectory: string) {
  try {
    const text = await readFile(path.join(inputDirectory, "registry.json"), "utf8");
    return ContentRegistrySchema.parse(JSON.parse(text) as unknown);
  } catch (error) {
    if (error instanceof ContentError) throw error;
    throw new ContentError("INVALID_CONTENT_REGISTRY", "Prepared registry is missing or invalid.", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function assertNoOrphanedMedia(
  publicDirectory: string,
  referencedPaths: Set<string>,
): Promise<void> {
  const mediaDirectory = path.join(publicDirectory, "media");
  let entries;
  try {
    entries = await readdir(mediaDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.[a-z0-9]+$/.test(entry.name)) continue;
    const mediaPath = `/media/${entry.name}`;
    if (!referencedPaths.has(mediaPath)) {
      throw new ContentError(
        "ORPHAN_MEDIA_FILE",
        `Generated media file is not referenced by the snapshot: ${mediaPath}`,
      );
    }
  }
}

function validateSiteRelationships(siteData: Awaited<ReturnType<typeof readSiteData>>): void {
  const ids = new Set<string>();
  for (const publication of siteData.publications) {
    if (ids.has(publication.id)) {
      throw new ContentError(
        "DUPLICATE_PUBLICATION",
        `Duplicate publication ID: ${publication.id}`,
      );
    }
    ids.add(publication.id);
  }
  const featured = new Set<string>();
  for (const id of siteData.siteConfig.featuredPublicationIds) {
    if (featured.has(id)) {
      throw new ContentError(
        "DUPLICATE_FEATURED_PUBLICATION",
        `Featured publication repeats: ${id}`,
      );
    }
    if (!ids.has(id)) {
      throw new ContentError("UNKNOWN_FEATURED_PUBLICATION", `Unknown featured publication: ${id}`);
    }
    featured.add(id);
  }
}

function validateRegistryMatchesSnapshot(
  posts: Array<{ sourceKey: string; slug: string; feedGuid: string }>,
  registryPosts: Array<{
    sourceKey: string;
    currentSlug: string;
    feedGuid: string;
    published: boolean;
  }>,
): void {
  const publishedRegistry = new Map(
    registryPosts.filter((post) => post.published).map((post) => [post.sourceKey, post]),
  );
  if (publishedRegistry.size !== posts.length) {
    throw new ContentError(
      "REGISTRY_SNAPSHOT_MISMATCH",
      "Registry public count differs from snapshot.",
    );
  }
  for (const post of posts) {
    const registered = publishedRegistry.get(post.sourceKey);
    if (
      !registered ||
      registered.currentSlug !== post.slug ||
      registered.feedGuid !== post.feedGuid
    ) {
      throw new ContentError(
        "REGISTRY_SNAPSHOT_MISMATCH",
        `Registry identity differs for post ${post.slug}.`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = parseCliArguments(process.argv.slice(2));
  assertKnownArguments(args, ["input", "public-dir", "source"], []);
  const result = await validatePreparedContent(
    args.values.get("input"),
    args.values.get("public-dir"),
    {
      expectedSource: args.values.has("source")
        ? parseExplicitSource(args.values.get("source"))
        : undefined,
    },
  );
  console.log(
    `Validated ${result.posts} post(s) and ${result.media} media asset(s) from ${result.sourceMode}.`,
  );
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entrypoint) {
  main().catch((error: unknown) => {
    const contentError = asContentError(error, "CONTENT_VALIDATE_FAILED");
    console.error(`[${contentError.code}] ${contentError.message}`);
    process.exitCode = 1;
  });
}
