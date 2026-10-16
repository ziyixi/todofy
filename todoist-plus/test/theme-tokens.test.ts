import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// Doist's public token package (MIT, CSS only) is a test-only devDependency, never bundled.
const require = createRequire(import.meta.url);
const themes = dirname(
  require.resolve("@doist/product-libraries-tokens/css/td-light.css"),
);
const radius =
  require.resolve("@doist/product-libraries-tokens/radius/css/radius.css");
/**
 * On the live Todoist page but not in the public package (content-free probe of 2026-10-15,
 * docs/todoist-plus-verification.md). Only names confirmed there belong here.
 */
const LIVE_ONLY = new Set([
  "shadow-raised-1",
  "shadow-raised-2",
  "shadow-raised-3",
]);
/** Todoist's component tokens (`--td-ui-*`) that Plus reads, each seen in the same live probe. */
const TD_UI = new Set(["font-family", "button-normal-height"]);

function tokenNames(text: string): Set<string> {
  return new Set(
    [...text.matchAll(/--product-library-([a-z0-9-]+)/gu)].map(
      (match) => match[1]!,
    ),
  );
}
const published = new Set([
  ...readdirSync(themes)
    .filter((file) => file.endsWith(".css"))
    .flatMap((file) => [
      ...tokenNames(readFileSync(join(themes, file), "utf8")),
    ]),
  ...tokenNames(readFileSync(radius, "utf8")),
]);
function sources(directory: string) {
  const root = fileURLToPath(new URL(directory, import.meta.url));
  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(css|ts|tsx)$/u.test(file))
    .map((file) => ({ file, text: readFileSync(join(root, file), "utf8") }));
}

/**
 * Token names in one file that Todoist does not define. A prefix followed by anything but a name
 * (`${role}`, a closing quote) is a name built at runtime, which this check cannot read.
 */
function unknownNames(file: string, text: string): string[] {
  return [
    ...[...tokenNames(text)]
      .filter((name) => !published.has(name) && !LIVE_ONLY.has(name))
      .map((name) => `${file}: --product-library-${name}`),
    ...[...text.matchAll(/--td-ui-([a-z0-9-]+)/gu)]
      .filter((match) => !TD_UI.has(match[1]!))
      .map((match) => `${file}: ${match[0]}`),
    ...[...text.matchAll(/--(?:product-library|td-ui)-(?![a-z0-9])/gu)].map(
      (match) => `${file}: ${match[0]}…`,
    ),
  ];
}

it("names only Todoist tokens that exist, so a typo or a removed token fails here", () => {
  expect(
    sources("../src/").flatMap(({ file, text }) => unknownNames(file, text)),
  ).toEqual([]);
  // The two names that once kept every theme Kale green would be caught.
  expect(published.has("actionable-primary-idle-tint")).toBe(false);
  expect(published.has("actionable-primary-selected-fill")).toBe(false);
  expect(published.has("actionable-tertiary-idle-tint")).toBe(true);
  // So would a name built at runtime and a misspelt component token.
  expect(
    unknownNames(
      "probe.ts",
      "var(--product-library-${role}) '--product-library-' + role var(--td-ui-button-normal-hieght, 32px) var(--td-ui-font-family)",
    ),
  ).toEqual([
    "probe.ts: --td-ui-button-normal-hieght",
    "probe.ts: --product-library-…",
    "probe.ts: --product-library-…",
  ]);
});

it("never imports the token package into the extension", () => {
  for (const { file, text } of [
    ...sources("../src/"),
    ...sources("../entrypoints/"),
  ])
    expect(text, file).not.toContain("product-libraries-tokens");
});
