import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertAssetLimits,
  MAX_ASSET_BYTES,
  renderHeadersFile,
  renderRedirectsFile,
} from "../../scripts/export/site-files";
import { prepareImageVariants } from "../../scripts/images/prepare";
import { productionOrigin } from "../../scripts/notion/status";
import {
  ALL_IMAGE_WIDTHS,
  pickVariantWidth,
  resolveImageVariant,
  variantWidths,
} from "../../src/lib/images/config";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("_headers", () => {
  const text = renderHeadersFile();

  it("sends Vercel's security headers and HSTS on every path", () => {
    const site = text.split("\n\n").find((block) => block.includes("/*\n"))!;
    for (const line of [
      "Referrer-Policy: strict-origin-when-cross-origin",
      "X-Content-Type-Options: nosniff",
      "X-Frame-Options: DENY",
      "Permissions-Policy: camera=(), microphone=(), geolocation=()",
      "Strict-Transport-Security: max-age=63072000",
    ]) {
      expect(site).toContain(`  ${line}`);
    }
    expect(text).not.toMatch(/includeSubDomains|preload/);
  });

  it("never caches the release identity and serves RSS and hashed files correctly", () => {
    expect(text).toContain("/build-info.json\n  Cache-Control: no-store, max-age=0");
    expect(text).toContain("/publication-state.json\n  Cache-Control: no-store, max-age=0");
    expect(text).toContain("/feed.xml\n  Content-Type: application/rss+xml; charset=utf-8");
    for (const prefix of ["/_next/static/*", "/media/*", "/_img/*"]) {
      expect(text).toContain(`${prefix}\n  Cache-Control: public, max-age=31536000, immutable`);
    }
  });
});

describe("_redirects", () => {
  it("writes each snapshot redirect as a literal 308 rule", () => {
    expect(renderRedirectsFile([{ from: "/blog/old-slug", to: "/blog/new-slug" }])).toContain(
      "/blog/old-slug /blog/new-slug 308\n",
    );
    expect(renderRedirectsFile([])).not.toMatch(/308/);
  });

  it("refuses placeholders, splats, external targets and duplicates", () => {
    expect(() => renderRedirectsFile([{ from: "/blog/:slug", to: "/blog" }])).toThrow();
    expect(() => renderRedirectsFile([{ from: "/old/*", to: "/blog" }])).toThrow();
    expect(() => renderRedirectsFile([{ from: "/old", to: "https://example.com/" }])).toThrow();
    expect(() => renderRedirectsFile([{ from: "/_img/x", to: "/blog" }])).toThrow();
    expect(() =>
      renderRedirectsFile([
        { from: "/old", to: "/blog" },
        { from: "/old", to: "/publications" },
      ]),
    ).toThrow(/Duplicate/);
  });
});

describe("static-asset limits", () => {
  it("accepts files below 25 MiB and refuses larger ones", () => {
    expect(() => assertAssetLimits([{ path: "a", bytes: MAX_ASSET_BYTES - 1 }])).not.toThrow();
    expect(() => assertAssetLimits([{ path: "video.mp4", bytes: MAX_ASSET_BYTES }])).toThrow(
      /video\.mp4/,
    );
  });
});

describe("build-time image variants", () => {
  it("never upscales and picks the smallest sufficient variant", () => {
    expect(variantWidths(300)).toEqual([64, 128, 160, 256, 300]);
    expect(variantWidths(5000)).toEqual([...ALL_IMAGE_WIDTHS, 5000]);
    expect(pickVariantWidth([64, 128, 300], 100)).toBe(128);
    expect(pickVariantWidth([64, 128, 300], 1360)).toBe(300);
  });

  it("maps known sources to hashed WebP files and leaves unknown ones alone", () => {
    const map = {
      version: 1 as const,
      images: {
        "/profile/a.png": { id: "0".repeat(20), width: 300, height: 400, widths: [64, 300] },
      },
    };
    expect(resolveImageVariant(map, "/profile/a.png", 128)).toBe(
      `/_img/${"0".repeat(20)}-300.webp`,
    );
    expect(resolveImageVariant(map, "/profile/other.gif", 128)).toBe("/profile/other.gif");
    expect(resolveImageVariant(map, "constructor", 128)).toBe("constructor");
  });

  it("writes one WebP per width, removes stale variants and records the map", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "website-images-test-"));
    temporaryDirectories.push(root);
    const publicDirectory = path.join(root, "public");
    await mkdir(path.join(publicDirectory, "profile"), { recursive: true });
    await mkdir(path.join(publicDirectory, "_img"), { recursive: true });
    await writeFile(path.join(publicDirectory, "_img", `${"9".repeat(20)}-64.webp`), "stale");
    await sharp({ create: { width: 700, height: 400, channels: 3, background: "#336699" } })
      .png()
      .toFile(path.join(publicDirectory, "profile", "portrait.png"));

    const { map, reports } = await prepareImageVariants({
      publicDirectory,
      sources: ["/profile/portrait.png"],
      generatedDirectory: path.join(root, ".generated"),
    });
    const entry = map.images["/profile/portrait.png"]!;
    expect(entry).toMatchObject({
      width: 700,
      height: 400,
      widths: [64, 128, 160, 256, 320, 384, 480, 640, 700],
    });
    const files = (await readdir(path.join(publicDirectory, "_img"))).sort();
    expect(files).toHaveLength(9);
    expect(files.every((file) => file.startsWith(entry.id))).toBe(true);
    const [small] = reports[0]!.variants;
    expect(small!.bytes).toBeLessThan(reports[0]!.sourceBytes);
    const metadata = await sharp(
      path.join(publicDirectory, "_img", `${entry.id}-320.webp`),
    ).metadata();
    expect([metadata.format, metadata.width]).toEqual(["webp", 320]);
    await expect(
      prepareImageVariants({
        publicDirectory,
        sources: ["/../secret.png"],
        generatedDirectory: path.join(root, ".generated"),
      }),
    ).rejects.toThrow(/plain root-relative/);
  });
});

describe("Notion feedback origin", () => {
  it("reads the canonical origin unless the release names the live hostname", () => {
    expect(productionOrigin(undefined)).toBe("https://www.ziyixi.science");
    expect(productionOrigin("https://website-preview.ziyixi.science")).toBe(
      "https://website-preview.ziyixi.science",
    );
    expect(() => productionOrigin("https://example.com/path")).toThrow();
    expect(() => productionOrigin("http://example.com")).toThrow();
  });
});
