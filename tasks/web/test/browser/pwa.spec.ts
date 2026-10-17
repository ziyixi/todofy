import { chromium, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("desktop PWA meets Chrome install checks and shows an honest offline page", async () => {
  // Installation is disabled in incognito. Use a disposable profile, never the owner's Chrome profile.
  const profile = await mkdtemp(join(tmpdir(), "tasks-pwa-test-"));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
  });
  try {
    const page = await context.newPage();
    await page.goto("http://127.0.0.1:8798/#/today");
    await expect(
      page.getByRole("heading", { name: "Today", exact: true }),
    ).toBeVisible();
    await page.evaluate(() => navigator.serviceWorker.ready);
    const session = await context.newCDPSession(page);
    const result = await session.send("Page.getAppManifest");
    expect(result.errors).toEqual([]);
    const manifest = JSON.parse(result.data || "{}");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/#/today");
    expect(
      manifest.icons.map((icon: { sizes: string }) => icon.sizes),
    ).toContain("512x512");
    expect(
      (await session.send("Page.getInstallabilityErrors")).installabilityErrors,
    ).toEqual([]);
    await page.reload();
    await context.setOffline(true);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Tasks is offline", exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => caches.keys())).toEqual([]);
    await context.setOffline(false);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Today", exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
});
