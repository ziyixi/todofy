import { defineConfig, devices } from "@playwright/test";

const port = 4173;
const deploymentBaseUrl = process.env.DEPLOYMENT_BASE_URL?.replace(/\/$/, "");

if (process.env.DEPLOYMENT_TEST_REQUIRED && !deploymentBaseUrl) {
  throw new Error("DEPLOYMENT_BASE_URL is required by the deployment-test entrypoint.");
}

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : "list",
  use: {
    baseURL: deploymentBaseUrl ?? `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chromium", use: { ...devices["Pixel 5"] } },
  ],
  webServer: deploymentBaseUrl
    ? undefined
    : {
        command: process.env.CI
          ? `pnpm start --hostname 127.0.0.1 --port ${port}`
          : `pnpm dev --hostname 127.0.0.1 --port ${port}`,
        url: `http://127.0.0.1:${port}`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
