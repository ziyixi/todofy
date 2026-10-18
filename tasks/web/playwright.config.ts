import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./test/browser",
  workers: 1,
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:8798", headless: true, timezoneId: "UTC" },
  webServer: {
    command: "node ../worker/test/runtime/dev-server.ts",
    url: "http://127.0.0.1:8798/api/tasks/csrf",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  reporter: "line",
});
