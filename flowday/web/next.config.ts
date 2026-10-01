import type { NextConfig } from "next";

const e2eBuildEnabled = process.env.E2E_TEST_MODE === "1";

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_FLOWDAY_E2E: e2eBuildEnabled ? "1" : "0",
  },
  output: "standalone",
  outputFileTracingRoot: import.meta.dirname,
  pageExtensions: e2eBuildEnabled
    ? ["e2e.ts", "tsx", "ts", "jsx", "js"]
    : ["tsx", "ts", "jsx", "js"],
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
