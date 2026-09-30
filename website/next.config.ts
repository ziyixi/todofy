import { access } from "node:fs/promises";
import path from "node:path";

import type { NextConfig } from "next";

import { DEVICE_SIZES, IMAGE_SIZES } from "./src/lib/images/config";

// The site is a static export served by Workers Static Assets (docs/architecture.md). Response
// headers and slug-change redirects therefore live in out/_headers and out/_redirects, which
// scripts/export/finalize.ts writes after `next build`; Next.js ignores headers()/redirects() here.
async function requirePreparedContent(): Promise<void> {
  const generated = path.join(process.cwd(), ".generated");
  try {
    await Promise.all([
      access(path.join(generated, "content", "snapshot.json")),
      access(path.join(generated, "images.json")),
    ]);
  } catch (error) {
    throw new Error(
      "Prepared content is required before running Next.js. Run `pnpm content:prepare:empty` or `pnpm content:prepare:fixture` first.",
      { cause: error },
    );
  }
}

export default async function config(): Promise<NextConfig> {
  await requirePreparedContent();
  return {
    output: "export",
    reactStrictMode: true,
    poweredByHeader: false,
    typedRoutes: true,
    images: {
      // Build-time WebP variants (scripts/images/prepare.ts) instead of a request-time optimizer.
      loader: "custom",
      loaderFile: "./src/lib/images/loader.ts",
      imageSizes: [...IMAGE_SIZES],
      deviceSizes: [...DEVICE_SIZES],
    },
  };
}
