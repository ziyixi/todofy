import { defineConfig } from "@playwright/test";

// Avoid port 3000: on macOS, the VSCode extension host and many dev tools
// squat there and accept TCP connections without answering HTTP. With
// reuseExistingServer:true that makes Playwright wait forever on the health
// probe and the test runner never starts. Override with PLAYWRIGHT_PORT if 4567
// also collides.
const port = Number(process.env.PLAYWRIGHT_PORT ?? 4567);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./__tests__/ui",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  forbidOnly: !!process.env.CI,
  outputDir: "output/playwright/artifacts",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "output/playwright/report" }],
  ],
  use: {
    baseURL,
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    // Optional: an already installed Chromium build (e.g. a newer one than this Playwright pins).
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } }
      : {}),
  },
  // The E2E static export served by the Worker under `wrangler dev` with a fresh local D1 (scripts/e2e-server.mjs).
  webServer: {
    command: `node scripts/e2e-server.mjs --port ${port}`,
    url: `${baseURL}/api/test/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
  projects: [
    {
      name: "desktop",
      grepInvert: /@portrait/,
      use: {
        viewport: { width: 1440, height: 960 },
        timezoneId: "UTC",
      },
    },
    {
      name: "portrait",
      grep: /@portrait/,
      use: {
        viewport: { width: 430, height: 932 },
        isMobile: true,
        timezoneId: "UTC",
      },
    },
  ],
});
