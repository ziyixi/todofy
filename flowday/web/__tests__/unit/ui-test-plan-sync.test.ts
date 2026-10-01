import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const planPath = path.join(process.cwd(), "..", "docs", "ui-test-plan.md");
const uiTestDir = path.join(process.cwd(), "__tests__", "ui");
const caseIdPattern = /\bUI-\d{3}\b/g;
const testTitlePattern = /\btest(?:\.only|\.skip)?\(\s*(['"`])([^'"`]+)\1/g;

function collectSpecFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSpecFiles(fullPath));
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".spec.ts")) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function parsePlanIds(markdown: string): string[] {
  const ids: string[] = [];
  const lines = markdown.split("\n");

  for (const line of lines) {
    const matches = line.match(caseIdPattern);
    if (!matches) continue;
    for (const match of matches) {
      ids.push(match);
    }
  }

  return ids;
}

function parseSpecTestTitles(source: string): string[] {
  const titles: string[] = [];
  for (const match of source.matchAll(testTitlePattern)) {
    titles.push(match[2]);
  }
  return titles;
}

describe("UI test plan sync", () => {
  it("keeps markdown case IDs and Playwright test IDs in lockstep", () => {
    const markdown = fs.readFileSync(planPath, "utf-8");
    const planIds = parsePlanIds(markdown);
    const planDuplicates = planIds.filter(
      (id, index) => planIds.indexOf(id) !== index
    );
    expect(planDuplicates).toEqual([]);

    const specFiles = collectSpecFiles(uiTestDir);
    expect(specFiles.length).toBeGreaterThan(0);

    const testTitles = specFiles.flatMap((file) =>
      parseSpecTestTitles(fs.readFileSync(file, "utf-8"))
    );
    expect(testTitles.length).toBeGreaterThan(0);

    const idsFromTests: string[] = [];
    for (const title of testTitles) {
      const matches = title.match(caseIdPattern) ?? [];
      expect(matches, `expected exactly one case ID in test title "${title}"`).toHaveLength(1);
      const id = matches[0]!;
      expect(
        title.startsWith(`[${id}] `),
        `expected test title "${title}" to start with [${id}]`
      ).toBe(true);
      idsFromTests.push(id);
    }

    const duplicateTestIds = idsFromTests.filter(
      (id, index) => idsFromTests.indexOf(id) !== index
    );
    expect(duplicateTestIds).toEqual([]);

    const sortedTestIds = [...idsFromTests].sort();
    expect(sortedTestIds).toEqual([...planIds].sort());
  });
});
