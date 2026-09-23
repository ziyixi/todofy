import { readFileSync } from "node:fs";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const publicationsFile = JSON.parse(
  readFileSync(new URL("../../content/publications.json", import.meta.url), "utf8"),
) as { publications: unknown[] };

const profile = JSON.parse(
  readFileSync(new URL("../../content/profile.json", import.meta.url), "utf8"),
) as { portrait: { src: string } };

test.describe("public site", () => {
  test("home follows the academic profile hierarchy", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("link", { name: "Ziyi Xi" })).toBeVisible();
    await expect(page.getByRole("link", { name: "About" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { level: 1, name: "About" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Blog" })).toBeVisible();
    await expect(
      page.getByRole("heading", { level: 2, name: "Selected publications" }),
    ).toBeVisible();
    await expect(page.getByAltText("Portrait of Ziyi Xi")).toBeVisible();
    await expect(page.getByRole("link", { name: "GitHub" })).toHaveAttribute(
      "href",
      "https://github.com/ziyixi",
    );

    const mainWidth = await page
      .locator("main")
      .evaluate((node) => node.getBoundingClientRect().width);
    expect(mainWidth).toBeLessThanOrEqual(800);
  });

  test("blog handles empty, fixture, and Notion article states", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });

    await page.goto("/blog");
    await expect(page.getByRole("heading", { level: 1, name: "Blog" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Blog" })).toHaveAttribute("aria-current", "page");

    const articleLinks = page.locator('main a[href^="/blog/"]');
    if ((await articleLinks.count()) === 0) {
      await expect(page.getByText("Writing will appear here.", { exact: true })).toBeVisible();
      expect(consoleErrors).toEqual([]);
      return;
    }

    const articlePath = await articleLinks.first().getAttribute("href");
    await articleLinks.first().click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("article")).toHaveAttribute("lang", /^(en|zh-CN)$/);
    expect((await page.locator("article").innerText()).length).toBeGreaterThan(200);
    if (articlePath === "/blog/reliable-content-pipelines") {
      await expect(page.locator("article pre").first()).toBeVisible();
      await expect(page.locator("article table")).toBeVisible();
      await expect(
        page.getByText("This article is synthetic and never production content."),
      ).toBeVisible();

      const bookmark = page.getByRole("link", { name: "Notion developer documentation" });
      await expect(bookmark).toHaveCount(1);
      await expect(bookmark).toHaveAttribute("href", "https://developers.notion.com/");
      await bookmark.focus();
      await expect(bookmark).toBeFocused();
    }
    await expect(page.locator("article a a")).toHaveCount(0);
    await expect(page.locator('article a[href="https://example.com/caption"]')).toHaveCount(0);
    expect(consoleErrors).toEqual([]);
  });

  test("Notion-style table of contents, toggled headings, tasks, and columns stay usable", async ({
    page,
  }) => {
    const response = await page.goto("/blog/reliable-content-pipelines");
    test.skip(response?.status() !== 200, "This test needs the synthetic fixture article.");

    const article = page.locator("article");
    const toc = article.locator("details", {
      has: page.locator("summary", { hasText: "On this page" }),
    });
    await expect(toc).toHaveCount(1);
    const nestedHeading = article.getByRole("heading", { name: "Nested section" });
    const toggleHeading = article.locator("details:has(> summary > h2#optional-details)");
    await expect(toggleHeading).toHaveAttribute("open", "");
    await expect(nestedHeading).toBeVisible();
    await toggleHeading.locator("summary").click();
    await expect(toggleHeading).not.toHaveAttribute("open", "");
    await toc.locator("summary").click();
    await toc.getByRole("link", { name: "Nested section" }).click();
    await expect(page).toHaveURL(/#nested-section$/);
    await expect(toggleHeading).toHaveAttribute("open", "");
    await expect(nestedHeading).toBeInViewport();

    await expect(article.getByRole("checkbox", { name: "Verify the snapshot" })).toBeChecked();
    await expect(article.getByRole("checkbox", { name: "Publish after review" })).not.toBeChecked();
    await expect(article.getByRole("checkbox", { name: "Verify the snapshot" })).toBeDisabled();

    const columns = article.locator('[style*="--column-template"]');
    const gridColumns = await columns.evaluate(
      (element) => getComputedStyle(element).gridTemplateColumns,
    );
    expect(gridColumns.split(" ").length).toBe(page.viewportSize()!.width <= 639 ? 1 : 2);
  });

  test("article images open at fitted or original size and return keyboard focus", async ({
    page,
  }) => {
    await page.goto("/blog");
    const articlePaths = await page
      .locator('main a[href^="/blog/"]')
      .evaluateAll((links) =>
        links
          .map((link) => link.getAttribute("href"))
          .filter((href): href is string => href !== null),
      );
    const trigger = page.locator('article button[aria-label^="Enlarge image"]').first();
    let foundImage = false;
    for (const articlePath of new Set(articlePaths)) {
      await page.goto(articlePath);
      if ((await trigger.count()) > 0) {
        foundImage = true;
        break;
      }
    }
    if (!foundImage) {
      test.skip(true, "This content mode has no article images.");
      return;
    }

    await expect(trigger).toBeVisible();
    const triggerBox = await trigger.boundingBox();
    expect(triggerBox?.width).toBeGreaterThan(0);
    expect(triggerBox?.height).toBeGreaterThan(0);
    if (test.info().project.name === "mobile-chromium") {
      await trigger.tap();
    } else {
      await trigger.click();
    }
    const dialog = page.getByRole("dialog", { name: /Expanded image/ });
    await expect(dialog).toBeVisible();
    const accessibility = await new AxeBuilder({ page }).analyze();
    expect(
      accessibility.violations.filter(
        (violation) => violation.impact === "critical" || violation.impact === "serious",
      ),
    ).toEqual([]);
    await expect(dialog.getByRole("button", { name: "Fit" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const image = dialog.locator("img");
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0);
    const fittedWidth = await image.evaluate((element) => element.getBoundingClientRect().width);
    const naturalWidth = await image.evaluate((element: HTMLImageElement) => element.naturalWidth);
    expect(fittedWidth).toBeLessThanOrEqual(page.viewportSize()!.width);

    await dialog.getByRole("button", { name: "Original size" }).click();
    await expect(dialog.getByRole("button", { name: "Original size" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    const originalWidth = await image.evaluate((element) => element.getBoundingClientRect().width);
    expect(originalWidth).toBe(naturalWidth);
    if (naturalWidth > fittedWidth) expect(originalWidth).toBeGreaterThan(fittedWidth);

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });

  test("publications exposes complete citations and real resources", async ({ page }) => {
    await page.goto("/publications");
    await expect(page.getByRole("heading", { level: 1, name: "Publications" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Publications" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(page.locator("main ol > li")).toHaveCount(publicationsFile.publications.length);
    await expect(page.getByRole("link", { name: /PyFK:/i })).toHaveCount(1);
    await expect(page.locator('a[href*="doi.org/undefined"]')).toHaveCount(0);
    await expect(
      page.getByText("Geophysical Journal International", { exact: false }).first(),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "DOI" }).first()).toHaveAttribute(
      "href",
      /^https:\/\/doi\.org\//,
    );
  });

  test("rendered pages retain canonical and Open Graph metadata", async ({ page }) => {
    const origin = "https://www.ziyixi.science";
    const sharedRoutes = ["/", "/blog", "/publications"];

    for (const route of sharedRoutes) {
      await page.goto(route);
      const expectedUrl = route === "/" ? origin : `${origin}${route}`;
      await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", expectedUrl);
      await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
        "content",
        `${origin}${profile.portrait.src}`,
      );
      await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute(
        "content",
        "Ziyi Xi",
      );
      await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute("content", "en_US");
      await expect(page.locator('meta[property="og:type"]')).toHaveAttribute("content", "website");
      await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", expectedUrl);
    }

    await page.goto("/blog");
    const articleLink = page.locator('main a[href^="/blog/"]').first();
    const articlePath =
      (await articleLink.count()) > 0 ? await articleLink.getAttribute("href") : null;
    if (!articlePath) return;

    await page.goto(articlePath);
    const articleLanguage = await page.locator("article").getAttribute("lang");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      new URL(articlePath, origin).toString(),
    );
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute(
      "content",
      `${origin}${profile.portrait.src}`,
    );
    await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute(
      "content",
      "Ziyi Xi",
    );
    await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute(
      "content",
      articleLanguage === "zh-CN" ? "zh_CN" : "en_US",
    );
    await expect(page.locator('meta[property="og:type"]')).toHaveAttribute("content", "article");
    await expect(page.locator('meta[property="og:url"]')).toHaveAttribute(
      "content",
      new URL(articlePath, origin).toString(),
    );
    await expect(page.locator('meta[property="article:published_time"]')).toHaveAttribute(
      "content",
      /^\d{4}-\d{2}-\d{2}T/,
    );
  });

  test("404 is a real not-found response", async ({ page }) => {
    const response = await page.goto("/definitely-not-a-page");
    expect(response?.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
    await expect(page.locator('link[rel="canonical"]')).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  });

  test("machine-readable routes remain public and deterministic", async ({ request }) => {
    const [feed, sitemap, robots, buildInfo] = await Promise.all([
      request.get("/feed.xml"),
      request.get("/sitemap.xml"),
      request.get("/robots.txt"),
      request.get("/build-info.json"),
    ]);

    expect(feed.status()).toBe(200);
    expect(feed.headers()["content-type"]).toContain("application/rss+xml");
    expect(await feed.text()).toContain('<rss version="2.0"');
    expect(sitemap.status()).toBe(200);
    expect(await sitemap.text()).toContain("https://www.ziyixi.science/");
    expect(robots.status()).toBe(200);
    expect(await robots.text()).toContain("Sitemap: https://www.ziyixi.science/sitemap.xml");
    expect(buildInfo.status()).toBe(200);
    expect(buildInfo.headers()["cache-control"]).toContain("no-store");
    expect(await buildInfo.json()).toEqual({
      codeSha: expect.any(String),
      configHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      schemaVersion: expect.any(Number),
    });
  });

  test("core pages have no serious or critical axe findings", async ({ page }) => {
    const paths = ["/", "/blog", "/publications"];
    await page.goto("/blog");
    const articleLink = page.locator('main a[href^="/blog/"]').first();
    const articlePath =
      (await articleLink.count()) > 0 ? await articleLink.getAttribute("href") : null;
    if (articlePath) paths.push(articlePath);

    for (const path of paths) {
      await page.goto(path);
      const results = await new AxeBuilder({ page }).analyze();
      const blocking = results.violations.filter(
        (violation) => violation.impact === "critical" || violation.impact === "serious",
      );
      expect(blocking, `${path}: ${JSON.stringify(blocking, null, 2)}`).toEqual([]);
    }
  });
});

test.describe("responsive layout", () => {
  test.use({ viewport: { height: 812, width: 375 } });

  test("mobile keeps the portrait before the biography without horizontal overflow", async ({
    page,
  }) => {
    await page.goto("/");
    const portrait = page.getByAltText("Portrait of Ziyi Xi");
    const firstParagraph = page.locator("main section p").first();
    const [portraitBox, paragraphBox, dimensions] = await Promise.all([
      portrait.boundingBox(),
      firstParagraph.boundingBox(),
      page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
      })),
    ]);
    expect(portraitBox).not.toBeNull();
    expect(paragraphBox).not.toBeNull();
    expect(portraitBox!.y + portraitBox!.height).toBeLessThanOrEqual(paragraphBox!.y);
    expect(dimensions.scrollWidth).toBe(dimensions.clientWidth);
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeVisible();
  });

  test("skip link reaches the main content", async ({ browserName, page }) => {
    test.skip(browserName === "webkit", "Mobile WebKit does not expose hardware Tab navigation.");
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to content" });
    await expect(skip).toBeFocused();
    await skip.press("Enter");
    await expect(page).toHaveURL(/#main-content$/);
    await expect(page.locator("#main-content")).toBeFocused();
  });
});
