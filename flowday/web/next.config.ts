import { join } from "node:path";
import type { NextConfig } from "next";

// A static export (out/): the Worker "flowday" serves it as static assets in front of its API (../wrangler.toml,
// ../docs/design.md). No Next.js server runs anywhere. E2E_TEST_MODE=1 builds the Playwright bridge in; the
// production build must not contain it (scripts/check-export.mjs).
const e2eBuildEnabled = process.env.E2E_TEST_MODE === "1";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_FLOWDAY_E2E: e2eBuildEnabled ? "1" : "0",
  },
  output: "export",
  productionBrowserSourceMaps: false,
  // web/ is the project root (the Worker's own package-lock.json sits next to it in ../worker).
  turbopack: { root: join(import.meta.dirname, "../..") },
};

export default nextConfig;
