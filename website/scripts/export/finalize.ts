import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readContentBundle } from "../../src/lib/content/reader";
import { assertAssetLimits, renderHeadersFile, renderRedirectsFile } from "./site-files";

/** Files every export must contain: the release verifier and the Notion status check read them. */
const REQUIRED_FILES = [
  "index.html",
  "404.html",
  "build-info.json",
  "publication-state.json",
  "feed.xml",
  "robots.txt",
  "sitemap.xml",
];

async function listFiles(
  directory: string,
  prefix = "",
): Promise<{ path: string; bytes: number }[]> {
  const files: { path: string; bytes: number }[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(absolute, relative)));
    else if (entry.isFile()) files.push({ path: relative, bytes: (await stat(absolute)).size });
    else throw new Error(`Unexpected non-file entry in the export: ${relative}`);
  }
  return files;
}

/**
 * Completes `next build` (output: "export") for Workers Static Assets: writes out/_headers and
 * out/_redirects, and checks the static-asset limits. Run by `pnpm build:site`.
 */
export async function finalizeExport(
  root = process.cwd(),
): Promise<{ files: number; bytes: number }> {
  const outDirectory = path.join(root, "out");
  for (const file of REQUIRED_FILES) {
    await stat(path.join(outDirectory, file)).catch(() => {
      throw new Error(`The static export is missing ${file}; run next build first.`);
    });
  }
  const { snapshot, manifest } = await readContentBundle(path.join(root, ".generated", "content"));
  await writeFile(path.join(outDirectory, "_headers"), renderHeadersFile());
  await writeFile(path.join(outDirectory, "_redirects"), renderRedirectsFile(snapshot.redirects));

  // The export must describe the snapshot it was built from.
  const buildInfo = JSON.parse(
    await readFile(path.join(outDirectory, "build-info.json"), "utf8"),
  ) as { contentHash?: unknown };
  if (buildInfo.contentHash !== manifest.contentHash) {
    throw new Error("out/build-info.json does not match the prepared content manifest.");
  }

  const files = await listFiles(outDirectory);
  assertAssetLimits(files);
  return { files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  finalizeExport()
    .then(({ files, bytes }) => {
      console.log(`Static export ready: ${files} files, ${bytes} bytes (out/).`);
    })
    .catch((error: unknown) => {
      console.error(`[EXPORT_FAILED] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
