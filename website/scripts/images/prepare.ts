import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import sharp from "sharp";

import {
  IMAGE_QUALITY,
  variantPath,
  variantWidths,
  type ImageVariantEntry,
  type ImageVariantMap,
} from "../../src/lib/images/config";
import { sha256 } from "../../src/lib/content/hash";
import { readContentBundle } from "../../src/lib/content/reader";
import type { ContentSnapshot, Profile } from "../../src/lib/content/schema";
import { readSiteData } from "../../src/lib/content/site-data";

/** Raster formats that get WebP variants. GIF (animation) and SVG keep their original URL. */
const RESIZABLE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const VARIANT_FILE = /^[a-f0-9]{20}-[1-9][0-9]*\.webp$/;

export interface ImageVariantReport {
  src: string;
  sourceBytes: number;
  variants: { width: number; bytes: number }[];
}

export interface PrepareImageVariantsOptions {
  publicDirectory: string;
  /** Root-relative public paths, e.g. "/profile/portrait.png" or "/media/<sha256>.png". */
  sources: string[];
  /** Where images.json is written (the directory that holds .generated/content). */
  generatedDirectory: string;
}

function publicFile(publicDirectory: string, src: string): string {
  if (!/^\/[A-Za-z0-9._/-]+$/.test(src) || src.split("/").some((part) => part === "..")) {
    throw new Error(`Image source must be a plain root-relative public path: ${src}`);
  }
  return path.join(publicDirectory, ...src.slice(1).split("/"));
}

async function exists(filename: string): Promise<boolean> {
  try {
    await stat(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function writeAtomically(filename: string, bytes: Uint8Array | string): Promise<void> {
  const temporary = `${filename}.${process.pid}.tmp`;
  await writeFile(temporary, bytes);
  await rename(temporary, filename);
}

/**
 * Writes `public/_img/<id>-<width>.webp` for every source and width, removes variants no source
 * needs any more, and writes the loader's map to `<generatedDirectory>/images.json`.
 */
export async function prepareImageVariants(
  options: PrepareImageVariantsOptions,
): Promise<{ map: ImageVariantMap; reports: ImageVariantReport[] }> {
  const outputDirectory = path.join(options.publicDirectory, "_img");
  await mkdir(outputDirectory, { recursive: true });
  const images: Record<string, ImageVariantEntry> = {};
  const reports: ImageVariantReport[] = [];
  const wanted = new Set<string>();

  for (const src of [...new Set(options.sources)].sort()) {
    const bytes = await readFile(publicFile(options.publicDirectory, src));
    const metadata = await sharp(bytes).metadata();
    if (!metadata.width || !metadata.height) throw new Error(`Image has no dimensions: ${src}`);
    // EXIF orientations 5-8 rotate by 90 degrees; rotate() below applies them.
    const rotated = (metadata.orientation ?? 1) >= 5;
    const width = rotated ? metadata.height : metadata.width;
    const height = rotated ? metadata.width : metadata.height;
    const id = sha256(bytes).slice(0, 20);
    const widths = variantWidths(width);
    const report: ImageVariantReport = { src, sourceBytes: bytes.byteLength, variants: [] };
    for (const variantWidth of widths) {
      const name = path.basename(variantPath(id, variantWidth));
      const target = path.join(outputDirectory, name);
      wanted.add(name);
      if (!(await exists(target))) {
        const output = await sharp(bytes)
          .rotate()
          .resize({ width: variantWidth, withoutEnlargement: true })
          .webp({ quality: IMAGE_QUALITY })
          .toBuffer();
        await writeAtomically(target, output);
      }
      report.variants.push({ width: variantWidth, bytes: (await stat(target)).size });
    }
    images[src] = { id, width, height, widths };
    reports.push(report);
  }

  for (const entry of await readdir(outputDirectory)) {
    if (VARIANT_FILE.test(entry) && !wanted.has(entry)) {
      await rm(path.join(outputDirectory, entry), { force: true });
    }
  }

  const map: ImageVariantMap = { version: 1, images };
  await mkdir(options.generatedDirectory, { recursive: true });
  await writeAtomically(
    path.join(options.generatedDirectory, "images.json"),
    `${JSON.stringify(map, null, 2)}\n`,
  );
  return { map, reports };
}

/** The images the site renders through next/image: the profile portrait and article images. */
export function imageSources(profile: Profile, snapshot: ContentSnapshot): string[] {
  return [
    profile.portrait.src,
    ...snapshot.media
      .filter((asset) => RESIZABLE_TYPES.has(asset.mimeType.toLowerCase()))
      .map((asset) => asset.path),
  ];
}

/**
 * Variants for the prepared snapshot in `contentDirectory` (normally .generated/content); the map
 * is written next to it (.generated/images.json). `pnpm content:prepare*` calls this after every
 * successful content step, so the loader's map always matches the snapshot the build reads.
 */
export async function prepareSiteImages(options: {
  root?: string;
  contentDirectory?: string;
  publicDirectory?: string;
}) {
  const root = options.root ?? process.cwd();
  const contentDirectory = options.contentDirectory ?? path.join(root, ".generated", "content");
  const [{ profile }, { snapshot }] = await Promise.all([
    readSiteData(path.join(root, "content")),
    readContentBundle(contentDirectory),
  ]);
  return prepareImageVariants({
    publicDirectory: options.publicDirectory ?? path.join(root, "public"),
    sources: imageSources(profile, snapshot),
    generatedDirectory: path.dirname(contentDirectory),
  });
}

export function summarizeReports(reports: ImageVariantReport[]): string {
  const sourceBytes = reports.reduce((sum, report) => sum + report.sourceBytes, 0);
  const variantBytes = reports.reduce(
    (sum, report) => sum + report.variants.reduce((total, variant) => total + variant.bytes, 0),
    0,
  );
  const files = reports.reduce((sum, report) => sum + report.variants.length, 0);
  return `Prepared ${files} WebP variant(s) for ${reports.length} image(s): sources ${sourceBytes} B, variants ${variantBytes} B in total.`;
}

async function main(): Promise<void> {
  const { reports } = await prepareSiteImages({});
  console.log(summarizeReports(reports));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(
      `[IMAGE_VARIANTS_FAILED] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
