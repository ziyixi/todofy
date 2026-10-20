import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// The commit a release builds, which its Worker also answers as BUILD_SHA (src/outdated.ts): the same choice
// as deploy/deploy-vars.mjs. Empty in development; fixed in unit tests.
const build = process.env.VITEST
  ? "unit-test-build"
  : process.env.BUILD_SOURCE_SHA || process.env.GITHUB_SHA || "";

export default defineConfig({
  plugins: [react()],
  define: { "import.meta.env.VITE_BUILD_SHA": JSON.stringify(build) },
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "@dnd-kit/react",
      "@dnd-kit/dom",
      "@dnd-kit/abstract",
      "@dnd-kit/state",
      "@dnd-kit/geometry",
      "@dnd-kit/collision",
    ],
  },
  server: { proxy: { "/api": "http://127.0.0.1:8798" } },
  test: {
    setupFiles: ["./test/setup.ts"],
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
