import { createHash } from "node:crypto";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { comparePostsNewestFirst, parseContentDate } from "../../src/lib/content/date";
import { asContentError, ContentError } from "../../src/lib/content/errors";
import { hashContentSnapshot, hashPublicConfig } from "../../src/lib/content/hash";
import { buildCandidateRegistry, emptyContentRegistry } from "../../src/lib/content/registry";
import {
  CONTENT_SCHEMA_VERSION,
  ContentManifestSchema,
  ContentRegistrySchema,
  ContentSnapshotSchema,
  MANIFEST_VERSION,
  PostSchema,
  type ContentManifest,
  type ContentRegistry,
  type ContentSnapshot,
} from "../../src/lib/content/schema";
import { readSiteData } from "../../src/lib/content/site-data";
import { stableStringify } from "../../src/lib/content/stable-json";
import { validateContentSnapshotWithOptions } from "../../src/lib/content/validate";
import { assertKnownArguments, parseCliArguments } from "./args";
import { assertModeBoundary, parseExplicitSource } from "./mode";
import { resolveRedirects } from "./redirects";
import type { MediaAsset, PreparedSource, SourceMode } from "./types";

export interface PrepareContentOptions {
  source: SourceMode;
  outputDirectory?: string;
  publicDirectory?: string;
  baseline?: ContentRegistry;
  bootstrap?: boolean;
  allowEmpty?: boolean;
  forRelease?: boolean;
  cutoff?: Date;
  completedAt?: Date;
  notion?: {
    token?: string;
    dataSourceId?: string;
    apiVersion?: string;
    allowedMediaHosts?: string[];
  };
}

export async function prepareContent(options: PrepareContentOptions): Promise<ContentManifest> {
  const outputDirectory = path.resolve(
    options.outputDirectory ?? path.join(process.cwd(), ".generated", "content"),
  );
  const publicDirectory = path.resolve(
    options.publicDirectory ?? path.join(process.cwd(), "public"),
  );
  const cutoff = options.cutoff ?? new Date();
  const completedAt = options.completedAt ?? new Date();
  const siteData = await readSiteData();

  assertModeBoundary(options.source, {
    forRelease: options.forRelease ?? false,
    notionToken: options.notion?.token,
    notionDataSourceId: options.notion?.dataSourceId,
  });
  if (options.forRelease && options.source !== siteData.siteConfig.blogSource) {
    throw new ContentError(
      "RELEASE_SOURCE_MISMATCH",
      `Release source ${options.source} does not match site.config.ts (${siteData.siteConfig.blogSource}).`,
    );
  }
  if (
    process.env.SITE_URL &&
    new URL(process.env.SITE_URL).origin !== siteData.siteConfig.canonicalOrigin
  ) {
    throw new ContentError(
      "SITE_URL_MISMATCH",
      "SITE_URL does not match the canonical origin in site.config.ts.",
    );
  }
  if (options.forRelease && !options.baseline && !options.bootstrap) {
    throw new ContentError(
      "MISSING_BASELINE",
      "A trusted release requires --baseline or an explicit --bootstrap.",
    );
  }
  if (options.source === "notion" && !options.baseline && !options.bootstrap) {
    throw new ContentError(
      "MISSING_BASELINE",
      "notion mode requires an explicit baseline registry or --bootstrap.",
    );
  }
  const baseline = options.baseline
    ? ContentRegistrySchema.parse(options.baseline)
    : emptyContentRegistry();
  const publicParent = path.dirname(publicDirectory);
  await mkdir(publicParent, { recursive: true });
  const transactionDirectory = await mkdtemp(path.join(publicParent, ".content-transaction-"));
  const stagedPublicDirectory = path.join(transactionDirectory, "public");
  await mkdir(stagedPublicDirectory, { recursive: true });

  try {
    // A source adapter may write several media files before a later page fails.
    // Keep all of them outside public/ until the complete snapshot is valid.
    const prepared = await prepareSource(options.source, {
      cutoff,
      publicDirectory: stagedPublicDirectory,
      notion: options.notion,
      notionConfig: siteData.siteConfig.notion,
    });
    const posts = prepared.posts
      .map((post) => PostSchema.parse(post))
      .sort(comparePostsNewestFirst);
    if (baseline.articleCount > 0 && posts.length === 0 && !options.allowEmpty) {
      throw new ContentError(
        "UNCONFIRMED_EMPTY_COLLECTION",
        `The candidate removes all ${baseline.articleCount} public articles; pass --allow-empty only after review.`,
      );
    }

    const { registry, redirects: automaticRedirects } = buildCandidateRegistry(posts, baseline);
    const redirects = resolveRedirects(siteData.redirects, posts, automaticRedirects);
    const snapshot = validateContentSnapshotWithOptions(
      ContentSnapshotSchema.parse({
        schemaVersion: CONTENT_SCHEMA_VERSION,
        sourceMode: options.source,
        posts,
        media: prepared.media,
        redirects,
      }),
      {
        allowCvPath: Boolean(siteData.profile.cvPath),
        canonicalOrigin: siteData.siteConfig.canonicalOrigin,
      },
    );
    const contentHash = hashContentSnapshot(snapshot);
    const manifest = ContentManifestSchema.parse({
      manifestVersion: MANIFEST_VERSION,
      schemaVersion: CONTENT_SCHEMA_VERSION,
      complete: true,
      sourceMode: options.source,
      contentHash,
      configHash: hashPublicConfig(siteData.siteConfig),
      snapshotFile: "snapshot.json",
      completedAt: parseContentDate(completedAt.toISOString()),
      postCount: snapshot.posts.length,
      mediaCount: snapshot.media.length,
      routes: buildRoutes(snapshot, registry),
      candidateRegistry: registry,
      diagnostics: prepared.diagnostics,
    });

    await commitMediaAndBundleAtomically({
      publicDirectory,
      stagedMediaDirectory: path.join(stagedPublicDirectory, "media"),
      transactionDirectory,
      assets: snapshot.media,
      commitBundle: () => writeBundleAtomically(outputDirectory, snapshot, manifest, registry),
    });
    return manifest;
  } finally {
    // The live files are hard-linked or renamed out of this directory before
    // commit. Best-effort cleanup cannot invalidate an already committed bundle.
    await rm(transactionDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function prepareSource(
  source: SourceMode,
  context: {
    cutoff: Date;
    publicDirectory: string;
    notion?: PrepareContentOptions["notion"];
    notionConfig: {
      apiVersion: string;
      propertyNames: {
        title: string;
        slug: string;
        status: string;
        publishedAt: string;
        summary: string;
        language: string;
        tags: string;
        translationKey?: string;
      };
    };
  },
): Promise<PreparedSource> {
  if (source === "empty") {
    const { prepareEmptySource } = await import("./adapters/empty");
    return prepareEmptySource(context);
  }
  if (source === "fixture") {
    const { prepareFixtureSource } = await import("./adapters/fixture");
    return prepareFixtureSource(context);
  }
  const { prepareNotionSource } = await import("./adapters/notion");
  return prepareNotionSource(context, {
    token: context.notion?.token ?? "",
    dataSourceId: context.notion?.dataSourceId ?? "",
    apiVersion: context.notion?.apiVersion ?? context.notionConfig.apiVersion,
    propertyNames: { ...context.notionConfig.propertyNames },
    ...(context.notion?.allowedMediaHosts
      ? { allowedMediaHosts: context.notion.allowedMediaHosts }
      : {}),
  });
}

function buildRoutes(
  snapshot: ContentSnapshot,
  registry: ContentRegistry,
): ContentManifest["routes"] {
  const absentPostPaths = registry.posts
    .filter((post) => !post.published)
    .flatMap((post) => [post.currentSlug, ...post.historicalSlugs])
    .map((slug) => `/blog/${slug}`);
  const routes: ContentManifest["routes"] = [
    { path: "/", expectedStatus: 200, kind: "page" },
    { path: "/blog", expectedStatus: 200, kind: "page" },
    { path: "/publications", expectedStatus: 200, kind: "page" },
    { path: "/feed.xml", expectedStatus: 200, kind: "feed" },
    { path: "/sitemap.xml", expectedStatus: 200, kind: "page" },
    { path: "/robots.txt", expectedStatus: 200, kind: "page" },
    ...snapshot.posts.map((post) => ({
      path: `/blog/${post.slug}`,
      expectedStatus: 200 as const,
      kind: "post" as const,
    })),
    ...snapshot.redirects.map((redirect) => ({
      path: redirect.from,
      expectedStatus: 308 as const,
      kind: "redirect" as const,
      expectedLocation: redirect.to,
    })),
    ...snapshot.media.map((asset) => ({
      path: asset.path,
      expectedStatus: 200 as const,
      kind: "asset" as const,
      sha256: asset.sha256,
      sizeBytes: asset.sizeBytes,
      mimeType: asset.mimeType,
    })),
    ...absentPostPaths.map((postPath) => ({
      path: postPath,
      expectedStatus: 404 as const,
      kind: "absent" as const,
    })),
  ];
  const paths = new Set<string>();
  for (const route of routes) {
    if (paths.has(route.path)) {
      throw new ContentError("DUPLICATE_MANIFEST_ROUTE", `Duplicate manifest route: ${route.path}`);
    }
    paths.add(route.path);
  }
  return routes.sort((left, right) => left.path.localeCompare(right.path));
}

async function writeBundleAtomically(
  outputDirectory: string,
  snapshot: ContentSnapshot,
  manifest: ContentManifest,
  registry: ContentRegistry,
): Promise<void> {
  assertSafeOutputDirectory(outputDirectory);
  const parent = path.dirname(outputDirectory);
  const staging = path.join(parent, `.content-stage-${process.pid}-${Date.now()}`);
  const backup = path.join(parent, `.content-backup-${process.pid}-${Date.now()}`);
  await mkdir(parent, { recursive: true });
  await mkdir(staging, { recursive: false });
  await Promise.all([
    writeFile(path.join(staging, "snapshot.json"), `${stableStringify(snapshot)}\n`, "utf8"),
    writeFile(path.join(staging, "registry.json"), `${stableStringify(registry)}\n`, "utf8"),
  ]);
  // The completion manifest is written last inside staging. The directory is then
  // swapped as a unit, so readers never accept an incomplete run.
  await writeFile(path.join(staging, "manifest.json"), `${stableStringify(manifest)}\n`, "utf8");

  let hadPrevious = false;
  try {
    await access(outputDirectory);
    await rename(outputDirectory, backup);
    hadPrevious = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
  try {
    await rename(staging, outputDirectory);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    if (hadPrevious) await rename(backup, outputDirectory);
    throw error;
  }
  // The swap above is the commit point. Failure to remove an obsolete backup
  // must not roll a complete new bundle back into a mixed state.
  if (hadPrevious) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
}

function assertSafeOutputDirectory(outputDirectory: string): void {
  if (
    path.basename(outputDirectory) !== "content" ||
    path.dirname(outputDirectory) === outputDirectory
  ) {
    throw new ContentError(
      "UNSAFE_OUTPUT_DIRECTORY",
      "Prepared output must be a directory named content, such as .generated/content.",
    );
  }
}

interface ContentTransactionOptions {
  publicDirectory: string;
  stagedMediaDirectory: string;
  transactionDirectory: string;
  assets: MediaAsset[];
  commitBundle: () => Promise<void>;
}

interface MovedMedia {
  livePath: string;
  backupPath: string;
}

/**
 * Installs content-addressed media and swaps the snapshot as one recoverable
 * transaction. New files are removed and pruned files restored when pruning or
 * bundle commit fails, so the previous snapshot remains fully usable.
 */
export async function commitMediaAndBundleAtomically(
  options: ContentTransactionOptions,
): Promise<void> {
  const referencedPaths = new Set(options.assets.map((asset) => asset.path));
  const mediaDirectory = path.join(options.publicDirectory, "media");
  const prunedBackupDirectory = path.join(options.transactionDirectory, "pruned-media");
  const introduced: string[] = [];
  const moved: MovedMedia[] = [];
  await mkdir(mediaDirectory, { recursive: true });
  await mkdir(prunedBackupDirectory, { recursive: true });

  try {
    for (const asset of options.assets) {
      const filename = path.basename(asset.path);
      const livePath = path.join(mediaDirectory, filename);
      const stagedPath = path.join(options.stagedMediaDirectory, filename);
      if (await fileExists(livePath)) {
        await assertMediaMatches(livePath, asset);
        continue;
      }
      await assertMediaMatches(stagedPath, asset);
      try {
        // Staging lives beside public/, so a hard link publishes the complete
        // file atomically without a second copy or an overwrite race.
        await link(stagedPath, livePath);
        introduced.push(livePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await assertMediaMatches(livePath, asset);
      }
    }

    const entries = await readdir(mediaDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !isGeneratedMediaFilename(entry.name)) continue;
      if (referencedPaths.has(`/media/${entry.name}`)) continue;
      const livePath = path.join(mediaDirectory, entry.name);
      const backupPath = path.join(prunedBackupDirectory, entry.name);
      await rename(livePath, backupPath);
      moved.push({ livePath, backupPath });
    }

    await options.commitBundle();
  } catch (error) {
    try {
      await rollbackMedia(introduced, moved);
    } catch (rollbackError) {
      throw new ContentError(
        "MEDIA_ROLLBACK_FAILED",
        `Media transaction failed and could not be rolled back: ${String(rollbackError)}`,
        { originalError: error instanceof Error ? error.message : String(error) },
      );
    }
    throw error;
  }
}

async function rollbackMedia(introduced: string[], moved: MovedMedia[]): Promise<void> {
  const errors: unknown[] = [];
  for (const livePath of introduced.reverse()) {
    try {
      await unlink(livePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(error);
    }
  }
  for (const item of moved.reverse()) {
    try {
      await rename(item.backupPath, item.livePath);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Could not restore media transaction.");
}

async function assertMediaMatches(filename: string, asset: MediaAsset): Promise<void> {
  let bytes: Buffer;
  try {
    bytes = await readFile(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ContentError("MISSING_MEDIA_FILE", `Prepared media file is missing: ${asset.path}`);
    }
    throw error;
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== asset.sha256 || bytes.byteLength !== asset.sizeBytes) {
    throw new ContentError(
      "MEDIA_HASH_MISMATCH",
      `Prepared media file does not match its snapshot metadata: ${asset.path}`,
    );
  }
}

async function fileExists(filename: string): Promise<boolean> {
  try {
    await access(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isGeneratedMediaFilename(filename: string): boolean {
  return /^[a-f0-9]{64}\.[a-z0-9]+$/.test(filename);
}

async function loadBaseline(filename: string | undefined): Promise<ContentRegistry | undefined> {
  if (!filename) return undefined;
  const text = await readFile(path.resolve(filename), "utf8");
  return ContentRegistrySchema.parse(JSON.parse(text) as unknown);
}

async function main(): Promise<void> {
  const args = parseCliArguments(process.argv.slice(2));
  assertKnownArguments(
    args,
    ["source", "baseline", "output", "public-dir", "cutoff"],
    ["bootstrap", "allow-empty", "for-release"],
  );
  const source = parseExplicitSource(args.values.get("source"));
  const cutoffValue = args.values.get("cutoff");
  const cutoff = cutoffValue ? new Date(parseContentDate(cutoffValue)) : new Date();
  const baseline = await loadBaseline(args.values.get("baseline"));
  const manifest = await prepareContent({
    source,
    ...(args.values.get("output") ? { outputDirectory: args.values.get("output") } : {}),
    ...(args.values.get("public-dir") ? { publicDirectory: args.values.get("public-dir") } : {}),
    ...(baseline ? { baseline } : {}),
    bootstrap: args.flags.has("bootstrap"),
    allowEmpty: args.flags.has("allow-empty"),
    forRelease: args.flags.has("for-release") || process.env.CONTENT_RELEASE === "true",
    cutoff,
    notion: {
      token: process.env.NOTION_TOKEN,
      dataSourceId: process.env.NOTION_DATA_SOURCE_ID,
      apiVersion: process.env.NOTION_API_VERSION,
      allowedMediaHosts: process.env.NOTION_MEDIA_HOSTS?.split(",")
        .map((host) => host.trim())
        .filter(Boolean),
    },
  });
  console.log(
    `Prepared ${manifest.postCount} post(s) from ${manifest.sourceMode}; contentHash=${manifest.contentHash}`,
  );
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entrypoint) {
  main().catch((error: unknown) => {
    const contentError = asContentError(error, "CONTENT_PREPARE_FAILED");
    console.error(`[${contentError.code}] ${contentError.message}`);
    process.exitCode = 1;
  });
}
