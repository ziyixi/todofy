#!/usr/bin/env node

import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const standaloneDir = path.join(rootDir, ".next", "standalone");

const forbiddenPathFragments = [
  `${path.sep}app${path.sep}api${path.sep}test${path.sep}`,
  `${path.sep}features${path.sep}testing${path.sep}`,
  `${path.sep}lib${path.sep}test${path.sep}`,
  `${path.sep}__tests__${path.sep}`,
];
const forbiddenTopLevelDirs = new Set(["docs", "output", "__tests__"]);

const forbiddenText = [
  "__FLOWDAY_E2E__",
  "installFlowdayE2EBridge",
  "seedE2ETestData",
  "clearE2ETestData",
  "/api/test/health",
  "/api/test/reset",
  "/api/test/seed",
  "/api/test/sync-orphans",
  "app/api/test",
  "features/testing/client",
  "features/testing/server",
];

const textFileExtensions = new Set([
  ".html",
  ".js",
  ".json",
  ".mjs",
  ".txt",
]);

function rel(filePath) {
  return path.relative(rootDir, filePath);
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir, visit) {
  if (!(await exists(dir))) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, visit);
    } else if (entry.isFile()) {
      await visit(fullPath);
    }
  }
}

async function removeGeneratedNonRuntimeFiles() {
  await rm(path.join(standaloneDir, "db"), { recursive: true, force: true });

  await walk(standaloneDir, async (filePath) => {
    const lower = filePath.toLowerCase();
    if (
      lower.endsWith(".map") ||
      lower.endsWith(".md") ||
      lower.endsWith(".markdown")
    ) {
      await rm(filePath, { force: true });
    }
  });
}

async function assertNoForbiddenPaths() {
  const leakedPaths = [];
  await walk(standaloneDir, async (filePath) => {
    const relativeToStandalone = path.relative(standaloneDir, filePath);
    const [topLevelDir] = relativeToStandalone.split(path.sep);
    const normalized = filePath.split(path.sep).join(path.sep);
    if (
      forbiddenTopLevelDirs.has(topLevelDir) ||
      forbiddenPathFragments.some((fragment) => normalized.includes(fragment))
    ) {
      leakedPaths.push(rel(filePath));
    }
  });

  if (leakedPaths.length > 0) {
    throw new Error(
      `Production standalone contains non-runtime paths:\n${leakedPaths
        .slice(0, 20)
        .join("\n")}`
    );
  }
}

async function assertNoForbiddenText() {
  const leakedText = [];
  await walk(standaloneDir, async (filePath) => {
    if (!textFileExtensions.has(path.extname(filePath))) return;
    const content = await readFile(filePath, "utf8").catch(() => "");
    const matched = forbiddenText.find((pattern) => content.includes(pattern));
    if (matched) {
      leakedText.push(`${rel(filePath)} contains ${matched}`);
    }
  });

  if (leakedText.length > 0) {
    throw new Error(
      `Production standalone contains test-only text:\n${leakedText
        .slice(0, 20)
        .join("\n")}`
    );
  }
}

async function main() {
  if (!(await exists(standaloneDir))) {
    throw new Error("Missing .next/standalone. Run npm run build first.");
  }

  await removeGeneratedNonRuntimeFiles();
  await assertNoForbiddenPaths();
  await assertNoForbiddenText();
  console.log("Production standalone is free of test routes, docs, source maps, and local DB files.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
