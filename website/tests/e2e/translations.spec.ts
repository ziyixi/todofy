import { expect, test } from "@playwright/test";

test("a bilingual article occupies one row and switches between complete language pages", async ({
  page,
  request,
}) => {
  await page.goto("/blog");
  const englishTitle = page.getByRole("link", {
    name: "Notes on reliable content pipelines",
    exact: true,
  });
  test.skip(process.env.CONTENT_MODE === "empty", "The empty snapshot has no bilingual fixture.");
  if (!process.env.CONTENT_MODE) {
    test.skip((await englishTitle.count()) === 0, "Requires the synthetic bilingual fixture.");
  }
  await expect(englishTitle).toBeVisible();

  await expect(page.locator("main > ol > li")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "可靠内容流水线笔记", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "English", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "中文", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "中文", exact: true }).click();

  await expect(page).toHaveURL(/\/blog\/reliable-content-pipelines-zh$/);
  await expect(page.locator("article")).toHaveAttribute("lang", "zh-CN");
  await expect(page.getByRole("heading", { level: 1, name: "可靠内容流水线笔记" })).toBeVisible();
  const languages = page.getByRole("navigation", { name: "Article language / 文章语言" });
  await expect(languages.getByText("中文", { exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://www.ziyixi.science/blog/reliable-content-pipelines-zh",
  );
  await expect(page.locator('link[rel="alternate"][hreflang="en"]')).toHaveAttribute(
    "href",
    "https://www.ziyixi.science/blog/reliable-content-pipelines",
  );
  await expect(page.locator('link[rel="alternate"][hreflang="zh-CN"]')).toHaveAttribute(
    "href",
    "https://www.ziyixi.science/blog/reliable-content-pipelines-zh",
  );

  await languages.getByRole("link", { name: "English", exact: true }).click();
  await expect(page.locator("article")).toHaveAttribute("lang", "en");
  await expect(
    page.getByRole("heading", { level: 1, name: "Notes on reliable content pipelines" }),
  ).toBeVisible();
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    "href",
    "https://www.ziyixi.science/blog/reliable-content-pipelines",
  );

  const sitemap = await request.get("/sitemap.xml");
  const sitemapEntries = (await sitemap.text()).match(/<url>[\s\S]*?<\/url>/g) ?? [];
  for (const slug of ["reliable-content-pipelines", "reliable-content-pipelines-zh"]) {
    const entry = sitemapEntries.find((entry) =>
      entry.includes(`<loc>https://www.ziyixi.science/blog/${slug}</loc>`),
    );
    expect(entry).toContain(
      'hreflang="en" href="https://www.ziyixi.science/blog/reliable-content-pipelines"',
    );
    expect(entry).toContain(
      'hreflang="zh-CN" href="https://www.ziyixi.science/blog/reliable-content-pipelines-zh"',
    );
  }
  const feed = await request.get("/feed.xml");
  expect((await feed.text()).match(/<item>/g)).toHaveLength(2);

  await page.goto("/");
  const blog = page.getByRole("region", { name: "Blog", exact: true });
  await expect(blog.locator("ol > li")).toHaveCount(1);
  await expect(blog.getByRole("link", { name: "中文", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
