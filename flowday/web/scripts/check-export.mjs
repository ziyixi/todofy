#!/usr/bin/env node
// Checks the production static export (out/, `npm run build`) that the Worker serves as static assets:
// - no E2E bridge, test route or test helper text, no source maps, docs or tests;
// - the manifest link asks for credentials (crossorigin="use-credentials", so it carries the Access cookie);
// - the PWA files the Worker serves without a JWT exist (worker/src/assets.ts PWA_PUBLIC_PATHS);
// - the file count stays far below Workers Static Assets' 20,000 files per version, each file below 25 MiB.
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(rootDir, "out");

const FORBIDDEN_TEXT = [
  "__FLOWDAY_E2E__",
  "installFlowdayE2EBridge",
  "/api/test/health",
  "/api/test/reset",
  "/api/test/seed",
  "/api/test/sync-orphans",
  "features/testing/client",
];
const TEXT_EXTENSIONS = new Set([".html", ".js", ".json", ".txt", ".css", ".webmanifest"]);
const PWA_FILES = [
  "pwa/manifest.webmanifest",
  "pwa/sw.js",
  "pwa/icon-192x192.png",
  "pwa/icon-512x512.png",
  "pwa/icon-maskable-512x512.png",
  "pwa/icon.svg",
  "pwa/apple-touch-icon.png",
];
const MAX_FILES = 1000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function main() {
  const files = await walk(outDir).catch(() => {
    throw new Error("Missing out/. Run npm run build first.");
  });
  const problems = [];
  let totalBytes = 0;
  for (const file of files) {
    const relative = path.relative(outDir, file);
    const { size } = await stat(file);
    totalBytes += size;
    if (size > MAX_FILE_BYTES) problems.push(`${relative} is larger than 25 MiB`);
    if (/\.map$|\.md$/i.test(relative) || /(^|\/)(docs|__tests__|output)\//.test(relative)) {
      problems.push(`${relative} is not a runtime file`);
    }
    if (!TEXT_EXTENSIONS.has(path.extname(file))) continue;
    const content = await readFile(file, "utf8");
    const marker = FORBIDDEN_TEXT.find((text) => content.includes(text));
    if (marker) problems.push(`${relative} contains ${marker}`);
  }
  if (files.length > MAX_FILES) problems.push(`${files.length} files (budget ${MAX_FILES})`);

  for (const file of PWA_FILES) {
    if (!files.includes(path.join(outDir, file))) problems.push(`missing ${file}`);
  }
  const index = await readFile(path.join(outDir, "index.html"), "utf8");
  if (!/<link rel="manifest" href="\/pwa\/manifest\.webmanifest" crossorigin="use-credentials"\/?>/.test(index)) {
    problems.push('index.html: the manifest link lacks crossorigin="use-credentials"');
  }

  if (problems.length > 0) {
    throw new Error(`The static export is not ready:\n${problems.slice(0, 30).join("\n")}`);
  }
  console.log(
    `Static export OK: ${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB, no test code, manifest with credentials.`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
